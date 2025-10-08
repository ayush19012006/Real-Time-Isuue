// public/main.js
const actorInput = document.getElementById('actor');
const addForm = document.getElementById('addForm');
const issuesTbody = document.querySelector('#issuesTable tbody');
const issueTemplate = document.getElementById('issue-row');

let issues = [];

// fetch initial issues
async function loadIssues() {
  const res = await fetch('/api/issues');
  const data = await res.json();
  issues = data.issues || [];
  renderIssues();
}

function renderIssues() {
  issuesTbody.innerHTML = '';
  issues.forEach(issue => {
    const clone = issueTemplate.content.cloneNode(true);
    clone.querySelector('.id').textContent = issue.id;
    clone.querySelector('.title').textContent = issue.title;
    clone.querySelector('.status').textContent = issue.status;
    clone.querySelector('.createdBy').textContent = issue.createdBy || issue.createdBy;

    const row = clone.querySelector('tr');
    const btnInProgress = clone.querySelector('.set-inprogress');
    const btnClosed = clone.querySelector('.set-closed');
    const btnComments = clone.querySelector('.show-comments');
    const commentArea = clone.querySelector('.comment-area');
    const commentsList = clone.querySelector('.comments-list');
    const commentForm = clone.querySelector('.comment-form');

    btnInProgress.addEventListener('click', () => updateStatus(issue.id, 'In Progress'));
    btnClosed.addEventListener('click', () => updateStatus(issue.id, 'Closed'));
    btnComments.addEventListener('click', () => {
      commentArea.style.display = commentArea.style.display === 'none' ? 'block' : 'none';
      renderComments(issue, commentsList);
    });

    commentForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = commentForm.elements['text'].value.trim();
      if (!text) return;
      addComment(issue.id, text);
      commentForm.reset();
    });

    issuesTbody.appendChild(row);
    // after DOM added, append comment area content (needs a container)
    const appended = issuesTbody.lastElementChild;
    const commentDiv = appended.querySelector('.comment-area');
    renderComments(issue, commentDiv.querySelector('.comments-list'));
  });
}

function renderComments(issue, container) {
  container.innerHTML = '';
  (issue.comments || []).forEach(c => {
    const el = document.createElement('div');
    el.className = 'comment';
    el.textContent = `${c.by} @ ${new Date(c.at).toLocaleString()}: ${c.text}`;
    container.appendChild(el);
  });
}

// WebSocket setup
const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${protocol}://${location.host}`);

ws.addEventListener('open', () => {
  console.log('WS opened');
});
ws.addEventListener('message', (ev) => {
  try {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'issue_added') {
      issues.push(msg.issue);
      renderIssues();
    } else if (msg.type === 'issue_updated') {
      const idx = issues.findIndex(i => i.id === msg.issue.id);
      if (idx >= 0) issues[idx] = msg.issue;
      else issues.push(msg.issue);
      renderIssues();
    } else if (msg.type === 'comment_added') {
      const idx = issues.findIndex(i => i.id === msg.id);
      if (idx >= 0) {
        issues[idx].comments = issues[idx].comments || [];
        issues[idx].comments.push(msg.comment);
      }
      renderIssues();
    }
  } catch (e) {
    console.error('invalid ws msg', ev.data);
  }
});

// Helper to send actions
function sendAction(type, payload) {
  const message = { type, payload: { ...payload, by: actorInput.value || 'Unknown' } };
  ws.send(JSON.stringify(message));
}

// API helpers (via WS)
function addIssue(title, description) {
  sendAction('add', { title, description });
}

function updateStatus(id, status) {
  sendAction('update', { id, status });
}

function addComment(id, text) {
  sendAction('comment', { id, text });
}

// wire create form
addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = addForm.elements['title'].value.trim();
  const description = addForm.elements['description'].value.trim();
  if (!title) return;
  addIssue(title, description);
  addForm.reset();
});

loadIssues().catch(console.error);
