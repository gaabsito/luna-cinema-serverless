const form = document.querySelector('#signup');
const status = document.querySelector('#form-status');
const button = form.querySelector('button');
function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // El hosting web de S3 usa HTTP: randomUUID solo existe en contextos seguros.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
let requestId = newId();
function message(text, kind = '') { status.textContent = text; status.className = kind; }
for (const link of document.querySelectorAll('[data-interest]')) {
  link.addEventListener('click', () => { form.elements.interest.value = link.dataset.interest; });
}
form.addEventListener('input', () => { requestId = newId(); });
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const apiUrl = window.CINEMA_CONFIG?.apiUrl;
  if (!apiUrl) { message('Las inscripciones todavía no están abiertas. Vuelve pronto.', 'error'); return; }
  const payload = {name: form.elements.name.value.trim(), email: form.elements.email.value.trim(), interest: form.elements.interest.value, consent: form.elements.consent.checked, requestId};
  if (payload.name.length < 2) { message('Escribe un nombre de al menos dos caracteres.', 'error'); return; }
  button.disabled = true; form.setAttribute('aria-busy', 'true'); message('Estamos guardando tu inscripción…');
  try {
    const response = await fetch(apiUrl, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), signal:AbortSignal.timeout(20000)});
    const data = await response.json();
    if (!response.ok || data.notified !== true) throw new Error(data.message || 'No pudimos completar la inscripción. Inténtalo de nuevo.');
    message('¡Ya formas parte del club! Tu inscripción se ha guardado. Nos vemos bajo las estrellas.', 'success');
    form.reset(); requestId = newId();
  } catch (error) {
    message(error.name === 'TimeoutError' || error instanceof TypeError ? 'No hemos podido confirmar tu inscripción. Comprueba tu conexión y vuelve a intentarlo.' : error.message, 'error');
  } finally { button.disabled = false; form.removeAttribute('aria-busy'); }
});
