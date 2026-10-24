const button = document.getElementById('create');
const error = document.getElementById('error');

button.addEventListener('click', async () => {
  button.disabled = true;
  error.hidden = true;
  try {
    const res = await fetch('/api/bins', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    location.href = `/b/${body.id}`;
  } catch (err) {
    error.textContent = `Could not create a bin: ${err.message}`;
    error.hidden = false;
    button.disabled = false;
  }
});
