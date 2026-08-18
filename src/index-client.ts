/** Client-side behavior for the server-rendered capture index. */
export const INDEX_CLIENT_SCRIPT = String.raw`
document.querySelectorAll('.item-more').forEach((menu) => menu.addEventListener('toggle', () => {
  if (!menu.open) return;
  document.querySelectorAll('.item-more[open]').forEach((other) => { if (other !== menu) other.open = false; });
}));
document.addEventListener('click', (event) => {
  document.querySelectorAll('.item-more[open]').forEach((menu) => { if (!menu.contains(event.target)) menu.open = false; });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') document.querySelectorAll('.item-more[open]').forEach((menu) => { menu.open = false; });
});

document.querySelectorAll('.delete').forEach((button) => button.addEventListener('click', async () => {
  const impact = JSON.parse(button.dataset.impact || '{}');
  const message = 'Permanently delete capture #' + button.dataset.id + '?\n\n' + button.dataset.title + '\n' + button.dataset.source + '\n' + button.dataset.time + '\n\nAffected relations: ' + (impact.aliases||0) + ' aliases, ' + (impact.metadata||0) + ' metadata rows, ' + (impact.tags||0) + ' tags. ' + (impact.jobs||0) + ' job records will be retained.';
  if (!confirm(message)) return;
  button.disabled = true;
  const response = await fetch('/api/captures/' + button.dataset.id, {method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:button.dataset.id})});
  if (response.ok) {
    const params = new URLSearchParams(location.search);
    const currentOffset = Number(params.get('offset') || 0);
    if (document.querySelectorAll('.item').length === 1 && currentOffset > 0) params.set('offset', String(Math.max(0, currentOffset - Number(params.get('limit') || 50))));
    location.search = params.toString();
  } else {
    button.disabled = false;
    alert('Deletion failed');
  }
}));

function renderTagEditor(editor, tags) {
  editor.replaceChildren();
  const list = document.createElement('div');
  list.className = 'tag-editor-list';
  if (!tags.length) {
    const empty = document.createElement('p');
    empty.className = 'tag-editor-empty';
    empty.textContent = 'No tags yet.';
    editor.append(empty);
  } else {
    tags.forEach((tag) => {
      const pill = document.createElement('span');
      pill.className = 'tag-editor-pill';
      const label = document.createElement('span');
      label.textContent = tag;
      const remove = document.createElement('button');
      remove.className = 'tag-editor-remove';
      remove.type = 'button';
      remove.dataset.tag = tag;
      remove.setAttribute('aria-label', 'Remove tag ' + tag);
      remove.textContent = '×';
      pill.append(label, remove);
      list.append(pill);
    });
    editor.append(list);
  }
  const status = document.createElement('p');
  status.className = 'tag-editor-status';
  status.hidden = true;
  status.setAttribute('role', 'status');
  const form = document.createElement('form');
  form.className = 'tag-editor-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.name = 'tag';
  input.maxLength = 100;
  input.placeholder = 'Add a tag';
  input.setAttribute('aria-label', 'New tag');
  const add = document.createElement('button');
  add.type = 'submit';
  add.textContent = 'Add';
  form.append(input, add);
  editor.append(status, form);
}

async function mutateCaptureTag(editor, method, tag) {
  const status = editor.querySelector('.tag-editor-status');
  status.hidden = false;
  status.textContent = method === 'POST' ? 'Adding tag…' : 'Removing tag…';
  editor.querySelectorAll('button,input').forEach((control) => { control.disabled = true; });
  try {
    const response = await fetch('/api/captures/' + editor.dataset.id + '/tags', {
      method,
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({tag}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not update tags');
    location.reload();
  } catch (error) {
    status.textContent = error?.message || 'Could not update tags';
    editor.querySelectorAll('button,input').forEach((control) => { control.disabled = false; });
  }
}

document.querySelectorAll('.manage-tags').forEach((button) => button.addEventListener('click', async () => {
  const editor = document.getElementById(button.getAttribute('aria-controls'));
  if (!editor.hidden) {
    editor.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  button.disabled = true;
  try {
    const response = await fetch('/api/captures/' + button.dataset.id + '/tags');
    if (!response.ok) throw new Error('Could not load tags');
    const data = await response.json();
    renderTagEditor(editor, data.tags || []);
    editor.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    editor.querySelector('input')?.focus();
  } catch (error) {
    alert(error?.message || 'Could not load tags');
  } finally {
    button.disabled = false;
  }
}));

document.addEventListener('submit', (event) => {
  const form = event.target.closest('.tag-editor-form');
  if (!form) return;
  event.preventDefault();
  const editor = form.closest('.tag-editor');
  const tag = form.elements.tag.value.trim();
  if (tag) mutateCaptureTag(editor, 'POST', tag);
});

document.addEventListener('click', (event) => {
  const remove = event.target.closest('.tag-editor-remove');
  if (!remove) return;
  mutateCaptureTag(remove.closest('.tag-editor'), 'DELETE', remove.dataset.tag);
});

document.querySelectorAll('.recapture').forEach((button) => button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const response = await fetch('/api/captures/' + button.dataset.id + '/recapture', {method:'POST'});
    if (!response.ok) throw new Error('Could not queue recapture');
    button.textContent = 'Recapture queued';
    setTimeout(() => {
      button.textContent = 'Recapture';
      button.disabled = false;
      button.closest('.item-more')?.removeAttribute('open');
    }, 1800);
  } catch {
    button.textContent = 'Recapture failed — try again';
    button.disabled = false;
  }
}));

const captureForm = document.getElementById('capture-form');
const captureInput = document.getElementById('capture-url');
const captureStatus = document.getElementById('capture-status');
const captureButton = captureForm.querySelector('button[type=submit]');
function setCaptureStatus(state, html) {
  captureStatus.dataset.state = state;
  captureStatus.innerHTML = html;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function followCaptureJob(jobId) {
  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    if (Date.now() >= deadline) {
      setCaptureStatus('progress', '<strong>Capture is still running.</strong> Job #' + jobId + ' has not finished yet. You can safely refresh this page and check Status later.');
      return;
    }
    await sleep(1200);
    const response = await fetch('/api/jobs/' + jobId, {headers:{'Accept':'application/json'}});
    if (!response.ok) throw new Error('Could not read job status');
    const job = await response.json();
    if (job.status === 'queued') {
      setCaptureStatus('progress', '<strong>Queued</strong> · job #' + jobId + ' is waiting for a capture worker.');
      continue;
    }
    if (job.status === 'running') {
      setCaptureStatus('progress', '<strong>Capturing</strong> · fetching the page and embedding its assets…');
      continue;
    }
    if (job.status === 'succeeded') {
      if (job.capture_id) setCaptureStatus('success', '<strong>Archived successfully.</strong> <a href="/captures/' + job.capture_id + '/article">Read capture #' + job.capture_id + '</a>');
      else setCaptureStatus('success', '<strong>Archived successfully.</strong> The capture is now available in the results below.');
      return;
    }
    const reason = job.error || 'The capture did not complete.';
    setCaptureStatus('error', '<strong>Capture failed.</strong> ' + escapeStatus(reason) + ' Check the URL and try again.');
    return;
  }
}
function escapeStatus(value) {
  const node = document.createElement('span');
  node.textContent = String(value);
  return node.innerHTML;
}
captureForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = captureInput.value.trim();
  if (!url) return;
  captureButton.disabled = true;
  setCaptureStatus('progress', '<strong>Submitting…</strong> Validating the URL and creating a capture job.');
  try {
    const response = await fetch('/api/captures', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
    const data = await response.json();
    if (!response.ok) {
      setCaptureStatus('error', '<strong>Could not queue capture.</strong> ' + escapeStatus(data.error || response.status));
      return;
    }
    captureInput.value = '';
    setCaptureStatus('progress', '<strong>Queued</strong> · job #' + data.jobId + ' is waiting for a capture worker.');
    await followCaptureJob(data.jobId);
  } catch (error) {
    setCaptureStatus('error', '<strong>Connection error.</strong> ' + escapeStatus(error?.message || error) + ' Try again.');
  } finally {
    captureButton.disabled = false;
  }
});
`;
