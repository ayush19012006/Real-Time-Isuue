// server.js
const express = require('express');
const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const DATA_PATH = path.join(__dirname, 'issues.json');
const PORT = parseInt(process.env.PORT, 10) || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache git availability to avoid repeated checks.
let _isGitRepo = null;
function isGitRepo() {
  if (_isGitRepo !== null) return _isGitRepo;
  try {
    const res = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: __dirname });
    if (res.status === 0 && String(res.stdout).trim() === 'true') {
      _isGitRepo = true;
    } else {
      _isGitRepo = false;
    }
  } catch (e) {
    _isGitRepo = false;
  }
  return _isGitRepo;
}

// Simple in-memory queue to serialize file writes + git commits
let writeQueue = Promise.resolve();

async function readData() {
  try {
    const raw = await fs.readFile(DATA_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    // If missing or invalid, initialize
    return { lastId: 0, issues: [] };
  }
}

async function atomicSaveAndCommit(newData, commitMessage, authorName) {
  // serialize operations
  writeQueue = writeQueue.then(async () => {
    const jsonStr = JSON.stringify(newData, null, 2);
    await fs.writeFile(DATA_PATH, jsonStr, 'utf8');

    // Only attempt git operations if this directory is a git repository.
    // Use a cached synchronous check to avoid repeated subprocess spawns.
    // If not a git repo, skip commit and resolve quietly.
    if (!isGitRepo()) {
      console.info('Not a git repository; skipping git commit.');
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      // Run `git add <file>` then `git commit -m <message> [--author ...]`.
      const add = spawn('git', ['add', DATA_PATH], { cwd: __dirname });
      let stderr = '';
      add.stderr.on('data', (d) => (stderr += d.toString()));
      add.on('error', (err) => {
        console.warn('git add failed:', err && err.message);
      });
      add.on('close', (code) => {
        if (code !== 0) {
          console.warn(`git add exited ${code}. stderr: ${stderr}`);
        }

        const commitArgs = ['commit', '-m', commitMessage];
        if (authorName) commitArgs.push('--author', `${authorName} <>`);
        const commit = spawn('git', commitArgs, { cwd: __dirname });
        let commitStderr = '';
        commit.stderr.on('data', (d) => (commitStderr += d.toString()));
        commit.on('error', (err) => {
          console.warn('git commit failed:', err && err.message);
          resolve();
        });
        commit.on('close', (c) => {
          if (c !== 0) {
            console.warn(`git commit exited ${c}. stderr: ${commitStderr}`);
          }
          resolve();
        });
      });
    });
  }).catch(err => {
    console.error('Error during queued write:', err);
  });

  return writeQueue;
}

// Minimal API used by front-end to fetch current issues
app.get('/api/issues', async (req, res) => {
  const data = await readData();
  res.json(data);
});

// Start server + WebSocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Prevent unhandled 'error' events coming from the WebSocket server
wss.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.warn('WebSocket server error: address in use');
  } else {
    console.error('WebSocket server error:', err);
  }
});

// Broadcast helper
function broadcastJSON(obj) {
  const text = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(text);
  }
}

wss.on('connection', (ws) => {
  // tell client it's connected
  ws.send(JSON.stringify({ type: 'hello', message: 'connected' }));

  ws.on('message', async (msg) => {
    // Expect messages as JSON: { type: 'add'|'update'|'comment', payload: {...} }
    let data;
    try { data = JSON.parse(msg); }
    catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid json' }));
      return;
    }

    try {
      const store = await readData();
      const { lastId, issues } = store;
      let commitMessage = '';
      const actor = (data.payload && data.payload.by) || 'Unknown';

      if (data.type === 'add') {
        const nextId = (store.lastId || 0) + 1;
        const newIssue = {
          id: nextId,
          title: String(data.payload.title || 'Untitled'),
          description: String(data.payload.description || ''),
          status: 'Open',
          createdBy: actor,
          createdAt: new Date().toISOString(),
          comments: []
        };
        store.issues.push(newIssue);
        store.lastId = nextId;
        commitMessage = `Issue #${nextId} created by ${actor}: ${newIssue.title}`;
        await atomicSaveAndCommit(store, commitMessage, actor);

        broadcastJSON({ type: 'issue_added', issue: newIssue, meta: { commitMessage } });
      } else if (data.type === 'update') {
        const { id, status } = data.payload;
        const issue = store.issues.find(i => i.id === id);
        if (!issue) {
          ws.send(JSON.stringify({ type: 'error', message: `Issue ${id} not found` }));
          return;
        }
        const oldStatus = issue.status;
        issue.status = status;
        issue.updatedAt = new Date().toISOString();
        commitMessage = `Issue #${id} status changed from ${oldStatus} to ${status} by ${actor}`;
        await atomicSaveAndCommit(store, commitMessage, actor);

        broadcastJSON({ type: 'issue_updated', issue, meta: { commitMessage } });
      } else if (data.type === 'comment') {
        const { id, text } = data.payload;
        const issue = store.issues.find(i => i.id === id);
        if (!issue) {
          ws.send(JSON.stringify({ type: 'error', message: `Issue ${id} not found` }));
          return;
        }
        const comment = {
          text: String(text),
          by: actor,
          at: new Date().toISOString()
        };
        issue.comments.push(comment);
        issue.updatedAt = comment.at;
        commitMessage = `Comment on Issue #${id} by ${actor}: ${comment.text.substring(0, 80)}`;
        await atomicSaveAndCommit(store, commitMessage, actor);

        broadcastJSON({ type: 'comment_added', id, comment, meta: { commitMessage } });
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'unknown message type' }));
      }
    } catch (err) {
      console.error('Error processing ws message:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'server error' }));
    }
  });
});

// Attempt to listen on PORT, but gracefully fall back if in use.
async function startServerWithFallback(startPort, maxPort = startPort + 10) {
  let port = startPort;

  while (port <= maxPort) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });

      console.log(`Server running at http://localhost:${port}`);
      console.log(`WebSocket ready on ws://localhost:${port}`);
      return port;
    } catch (err) {
      // If port is in use, try next one; otherwise rethrow
      if (err && err.code === 'EADDRINUSE') {
        console.warn(`Port ${port} in use, trying ${port + 1}...`);
        port += 1;
        // create a fresh server instance listener state by closing and recreating
        // Note: server was not listening when error emitted, so we can continue.
        continue;
      }
      console.error('Failed to start server:', err);
      throw err;
    }
  }

  throw new Error(`No available ports between ${startPort} and ${maxPort}`);
}

startServerWithFallback(PORT).catch((err) => {
  console.error('Fatal: could not start server:', err);
  process.exit(1);
});
