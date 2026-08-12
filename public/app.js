const state = {
  photo: null, // File object
  uploadId: null,
  price: 5.0,
};

const els = {
  slots: document.querySelectorAll('.photo-slot'),
  payBtn: document.getElementById('pay-btn'),
  payBtnText: document.getElementById('pay-btn-text'),
  priceHint: document.getElementById('price-hint'),
  errorText: document.getElementById('error-text'),
  previewPlaceholder: document.getElementById('preview-placeholder'),
  previewImage: document.getElementById('preview-image'),
  previewLoading: document.getElementById('preview-loading'),
  downloadBtn: document.getElementById('download-btn'),
  gallery: document.getElementById('gallery'),
  budgetPill: document.getElementById('budget-pill'),
  budgetText: document.getElementById('budget-text'),
};

// ---------- budget / price ----------

async function refreshBudget() {
  try {
    const res = await fetch('/api/budget');
    const data = await res.json();
    els.budgetText.textContent = `$${data.remainingUsd.toFixed(2)} left of $${data.dailyBudgetUsd.toFixed(2)} today`;
    state.price = data.upscalePriceUsd;
    els.payBtnText.textContent = `Pay $${state.price.toFixed(2)} to Upscale to 4K`;
    return data;
  } catch (err) {
    els.budgetText.textContent = 'Budget unavailable';
  }
}

// ---------- photo slot ----------

els.slots.forEach((slot) => {
  const input = slot.querySelector('.photo-input');

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove-btn';
  removeBtn.innerHTML = '&times;';
  removeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.photo = null;
    state.uploadId = null;
    input.value = '';
    const thumb = slot.querySelector('img.thumb');
    if (thumb) thumb.remove();
    slot.classList.remove('filled');
    els.payBtn.disabled = true;
    els.previewImage.classList.add('hidden');
    els.previewPlaceholder.classList.remove('hidden');
    els.downloadBtn.classList.add('hidden');
  });
  slot.appendChild(removeBtn);

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    state.photo = file;

    let thumb = slot.querySelector('img.thumb');
    if (!thumb) {
      thumb = document.createElement('img');
      thumb.className = 'thumb';
      slot.insertBefore(thumb, removeBtn);
    }
    thumb.src = URL.createObjectURL(file);
    slot.classList.add('filled');

    await uploadPhoto(file);
  });
});

async function uploadPhoto(file) {
  showError('');
  els.payBtn.disabled = true;
  try {
    const formData = new FormData();
    formData.append('photo', file);
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Upload failed.');
    }
    state.uploadId = data.id;
    els.previewPlaceholder.classList.add('hidden');
    els.previewImage.src = data.originalUrl;
    els.previewImage.classList.remove('hidden');
    els.payBtn.disabled = false;
    await refreshHistory();
  } catch (err) {
    showError(err.message || 'Upload failed.');
  }
}

// ---------- gallery ----------

function renderGallery(history) {
  els.gallery.innerHTML = '';
  if (!history || history.length === 0) {
    els.gallery.innerHTML = '<p class="gallery-empty">Your uploads will show up here.</p>';
    return;
  }
  history.forEach((entry) => {
    const item = document.createElement('div');
    item.className = 'gallery-item';
    const actionHtml = entry.upscaledUrl
      ? `<a class="gallery-download" href="/api/download/${entry.id}" title="Download 4K">&#8681;</a>`
      : `<button class="gallery-download" data-upload-id="${entry.id}" title="Pay $${state.price.toFixed(2)} to upscale">&#8681;</button>`;
    item.innerHTML = `
      <img src="${entry.originalUrl}" alt="Uploaded image" />
      ${actionHtml}
    `;
    els.gallery.appendChild(item);
  });
}

async function refreshHistory() {
  try {
    const res = await fetch('/api/history');
    const history = await res.json();
    renderGallery(history);
  } catch (err) {
    renderGallery([]);
  }
}

els.gallery.addEventListener('click', (e) => {
  const btn = e.target.closest('button.gallery-download');
  if (btn) startCheckout(btn.dataset.uploadId);
});

// ---------- paywall ----------

async function startCheckout(uploadId) {
  if (!uploadId) return;
  showError('');
  try {
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Could not start checkout.');
    }
    if (data.alreadyPaid) {
      window.location.href = `/api/download/${uploadId}`;
      return;
    }
    window.location.href = data.url;
  } catch (err) {
    showError(err.message || 'Could not start checkout.');
  }
}

async function handlePaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  const paidUpload = params.get('paid_upload');
  const sessionId = params.get('session_id');
  if (!paidUpload || !sessionId) return;

  window.history.replaceState({}, '', window.location.pathname);

  setUpscaling(true);
  showError('');

  try {
    const res = await fetch(`/api/verify-payment?session_id=${encodeURIComponent(sessionId)}`);
    const data = await res.json();
    if (res.ok && data.paid) {
      state.uploadId = paidUpload;
      els.previewPlaceholder.classList.add('hidden');
      els.previewImage.src = data.upscaledUrl;
      els.previewImage.classList.remove('hidden');
      els.downloadBtn.classList.remove('hidden');
      triggerDownload(paidUpload);
      await refreshHistory();
      await refreshBudget();
    } else {
      showError(data.error || 'Payment could not be verified.');
    }
  } catch (err) {
    showError('Payment could not be verified.');
  } finally {
    setUpscaling(false);
  }
}

function triggerDownload(uploadId) {
  const a = document.createElement('a');
  a.href = `/api/download/${uploadId}`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function setUpscaling(isUpscaling) {
  els.previewLoading.classList.toggle('hidden', !isUpscaling);
}

function showError(message) {
  els.errorText.textContent = message || '';
}

els.payBtn.addEventListener('click', () => startCheckout(state.uploadId));
els.downloadBtn.addEventListener('click', () => triggerDownload(state.uploadId));

// ---------- init ----------

refreshBudget();
refreshHistory();
handlePaymentReturn();
