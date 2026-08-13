/** Client-side behavior for the server-rendered capture index. */
export const INDEX_CLIENT_SCRIPT = String.raw`
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

document.querySelectorAll('.recapture').forEach((button) => button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const response = await fetch('/api/captures/' + button.dataset.id + '/recapture', {method:'POST'});
    if (!response.ok) throw new Error('Could not queue recapture');
    button.textContent = '✓';
    button.setAttribute('aria-label', 'Recapture queued');
    button.title = 'Recapture queued';
    setTimeout(() => {
      button.textContent = '↻';
      button.setAttribute('aria-label', 'Capture again now');
      button.title = 'Capture again now';
      button.disabled = false;
    }, 1800);
  } catch {
    button.textContent = '!';
    button.setAttribute('aria-label', 'Recapture failed; try again');
    button.title = 'Recapture failed; try again';
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
      if (job.capture_id) setCaptureStatus('success', '<strong>Archived successfully.</strong> <a href="/captures/' + job.capture_id + '">Open capture #' + job.capture_id + '</a>');
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
