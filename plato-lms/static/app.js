(() => {
  'use strict';

  /* ---------- Theme (applied immediately to avoid a flash) ---------- */
  const root = document.documentElement;
  const THEME_KEY = 'plato-theme';
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
  } catch (_) { /* storage can be blocked; fall back to the OS setting */ }

  const currentTheme = () => root.dataset.theme || (darkQuery.matches ? 'dark' : 'light');

  /* ---------- Helpers ---------- */
  const csrfToken = () =>
    document.querySelector('meta[name="csrf-token"]')?.content ||
    document.querySelector('input[name="csrf_token"]')?.value || '';

  const post = (url, body) => fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Accept': 'application/json', 'X-CSRFToken': csrfToken(),
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

  let toastTimer;
  function toast(message, type = 'info') {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.className = 'toast' + (type === 'error' ? ' error' : '');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  async function readJson(res) {
    try { return await res.json(); } catch (_) { return {}; }
  }

  document.addEventListener('DOMContentLoaded', () => {

    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    }

    /* ---------- Theme toggle (injected into the nav) ---------- */
    const nav = document.querySelector('nav');
    if (nav) {
      const btn = nav.querySelector('.theme-toggle') || document.createElement('button');
      btn.type = 'button';
      btn.className = 'theme-toggle';
      btn.setAttribute('aria-pressed', String(currentTheme() === 'dark'));
      const label = () => {
        const next = currentTheme() === 'dark' ? 'light' : 'dark';
        btn.textContent = next === 'light' ? 'Light mode' : 'Dark mode';
        btn.setAttribute('aria-label', `Switch to ${next} mode`);
        btn.setAttribute('aria-pressed', String(currentTheme() === 'dark'));
      };
      btn.addEventListener('click', () => {
        const next = currentTheme() === 'dark' ? 'light' : 'dark';
        root.dataset.theme = next;
        try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
        label();
      });
      darkQuery.addEventListener('change', label);
      label();
      if (!btn.isConnected) (nav.querySelector('.nav-actions') || nav).appendChild(btn);
    }

    /* ---------- Course search ---------- */
    const search = document.getElementById('course-search');
    if (search) {
      const cards = [...document.querySelectorAll('.course-card')];
      let empty = document.getElementById('no-results');
      if (!empty && cards.length) {
        empty = document.createElement('p');
        empty.id = 'no-results';
        empty.className = 'empty';
        empty.hidden = true;
        empty.textContent = 'No courses match your search.';
        cards[0].parentElement.after(empty);
      }
      search.addEventListener('input', e => {
        const q = e.target.value.trim().toLowerCase();
        let visible = 0;
        cards.forEach(c => {
          const text = (c.dataset.title || c.textContent).toLowerCase();
          const show = text.includes(q);
          c.style.display = show ? '' : 'none';
          if (show) visible++;
        });
        if (empty) empty.hidden = visible > 0;
      });
    }

    /* ---------- Modals ---------- */
    let lastTrigger = null;
    const openModal = (modal, trigger) => {
      lastTrigger = trigger;
      modal.classList.add('open');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.querySelector('input, textarea, select, button, a[href]')?.focus();
    };
    const closeModal = modal => {
      modal.classList.remove('open');
      lastTrigger?.focus();
    };

    document.querySelectorAll('[data-modal]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modal = document.getElementById(btn.dataset.modal);
        if (modal) openModal(modal, btn);
      });
    });
    document.querySelectorAll('.modal .close').forEach(x => {
      x.setAttribute('aria-label', 'Close');
      if (!x.hasAttribute('tabindex') && x.tagName !== 'BUTTON') {
        x.setAttribute('tabindex', '0');
        x.setAttribute('role', 'button');
        x.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); x.click(); }
        });
      }
      x.addEventListener('click', () => closeModal(x.closest('.modal')));
    });
    document.querySelectorAll('.modal').forEach(m => {
      m.addEventListener('click', e => { if (e.target === m) closeModal(m); });
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const open = document.querySelector('.modal.open');
      if (open) closeModal(open);
    });

    /* ---------- Enroll (AJAX) ---------- */
    document.querySelectorAll('.enroll-btn').forEach(b => {
      b.addEventListener('click', async () => {
        const url = b.dataset.url || `/course/${b.dataset.course}/enroll`;
        b.disabled = true;
        try {
          const res = await post(url);
          if (res.status === 401) {
            location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
            return;
          }
          const data = await readJson(res);
          if (!res.ok) throw new Error(data.error || 'Could not enroll. Try again.');
          b.textContent = 'Enrolled';
          toast(data.message || 'Enrolled successfully');
        } catch (err) {
          b.disabled = false;
          toast(err.message, 'error');
        }
      });
    });

    /* ---------- Lesson progress ---------- */
    document.querySelectorAll('.complete-btn').forEach(b => {
      const render = done => {
        b.setAttribute('aria-pressed', String(done));
        b.textContent = done ? 'Completed' : 'Mark complete';
        b.closest('.lesson')?.classList.toggle('done', done);
      };
      render(b.getAttribute('aria-pressed') === 'true');

      b.addEventListener('click', async () => {
        const url = b.dataset.url || `/lesson/${b.dataset.lesson}/complete`;
        b.disabled = true;
        try {
          const res = await post(url, { completed: b.getAttribute('aria-pressed') !== 'true' });
          const data = await readJson(res);
          if (!res.ok) throw new Error(data.error || 'Could not save your progress.');
          render(data.completed);
          const bar = document.querySelector('.progress > div');
          if (bar && typeof data.percent === 'number') {
            bar.style.width = `${data.percent}%`;
            bar.closest('[role="progressbar"]')?.setAttribute('aria-valuenow', String(data.percent));
          }
          const label = document.querySelector('[data-progress-label]');
          if (label && typeof data.done === 'number') {
            label.textContent = `${data.done} of ${data.total} lessons complete`;
          }
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          b.disabled = false;
        }
      });
    });

    // Progress bars rendered by the server carry their value in data-percent.
    document.querySelectorAll('.progress[data-percent]').forEach(p => {
      const bar = p.firstElementChild;
      if (bar) bar.style.width = `${p.dataset.percent}%`;
    });

    /* ---------- Confirm destructive actions, prevent double submits ---------- */
    document.querySelectorAll('form').forEach(form => {
      form.addEventListener('submit', e => {
        const msg = form.dataset.confirm;
        if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
        setTimeout(() => {
          form.querySelectorAll('button[type="submit"], button:not([type])')
            .forEach(btn => { btn.disabled = true; });
        }, 0);
      });
    });
  });
})();
