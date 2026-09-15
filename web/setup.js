export function bindSetup(api, refresh, notify) {
  const $ = id => document.getElementById(id);
  let account = null, generation = 0, busy = false;
  const buttons = ['psn-login', 'psn-complete', 'psn-lookup', 'psn-disconnect', 'auto-pair'];
  const status = text => { $('psn-status').textContent = text; $('psn-status').hidden = !text; };
  const update = value => {
    account = value;
    $('psn-account-status').textContent = value ? `Account saved: ${value.onlineId}` : 'Sign in to PSN to fill in your account and pair automatically.';
    $('psn-disconnect').hidden = !value;
    $('psn-login').textContent = value ? 'Change PSN account' : 'Sign in to PSN';
    $('auto-pair').hidden = !value?.canAutoPair;
    if (value) { $('account-id').value = value.accountId; $('account-id').dispatchEvent(new Event('input')); }
  };
  async function action(button, text, task) {
    if (busy) return;
    busy = true;
    const current = ++generation, label = button.textContent;
    for (const id of buttons) $(id).disabled = true;
    button.textContent = text;
    status('');
    try { await task(() => current === generation); }
    catch (error) { if (current === generation) status(error.name === 'AbortError' ? 'The request timed out. Please try again.' : error.message); }
    finally { busy = false; for (const id of buttons) $(id).disabled = false; button.textContent = label; }
  }
  $('add-console').onclick = () => { $('setup-dialog').showModal(); $('console-search').open = !$('host-ip').value; };
  $('account-settings').onclick = () => $('setup-dialog').showModal();
  $('close-setup').onclick = () => $('setup-dialog').close();
  $('psn-login').onclick = () => action($('psn-login'), 'Preparing sign-in…', async active => {
    const result = await api('psn/login', {});
    if (!active()) return;
    $('psn-login-link').href = result.loginUrl;
    $('psn-copy-url').value = result.loginUrl;
    $('psn-redirect').value = '';
    $('psn-login-flow').hidden = false;
    $('psn-login-link').focus();
  });
  $('psn-copy-link').onclick = async () => {
    try { await navigator.clipboard.writeText($('psn-copy-url').value); status('Sign-in link copied. Open it in another browser.'); }
    catch { $('psn-copy-url').focus(); $('psn-copy-url').select(); status('Select and copy the sign-in link above.'); }
  };
  $('psn-complete').onclick = () => action($('psn-complete'), 'Connecting…', async active => {
    const redirectUrl = $('psn-redirect').value.trim();
    if (!redirectUrl) throw new Error('Paste the redirect URL from Sony’s sign-in page.');
    $('psn-redirect').value = '';
    const result = await api('psn/account', { redirectUrl }, { timeout: 25000 });
    if (!active()) return;
    update(result);
    $('psn-login-flow').hidden = true;
    status('PSN account connected. Select your console and pair automatically, or use a PIN.');
    $('auto-pair').focus();
  });
  $('psn-lookup').onclick = () => action($('psn-lookup'), 'Looking up…', async active => {
    const onlineId = $('psn-online-name').value.trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{2,15}$/.test(onlineId)) throw new Error('Enter your PSN online name (3–16 characters, starting with a letter).');
    const result = await api('psn/lookup', { onlineId });
    if (!active()) return;
    update(result);
    status(`Found ${result.onlineId}. Enter the Link Device PIN from your console.`);
    $('pin').focus();
  });
  $('psn-disconnect').onclick = () => action($('psn-disconnect'), 'Removing…', async active => {
    await api('psn/account', undefined, { method: 'DELETE' });
    if (!active()) return;
    update(null);
    $('account-id').value = '';
    $('account-id-preview').hidden = true;
    $('psn-login-flow').hidden = true;
    status('Saved PSN account removed. Your paired consoles remain available.');
  });
  $('auto-pair').onclick = () => action($('auto-pair'), 'Pairing…', async active => {
    const hostIp = $('host-ip').value.trim();
    if (!hostIp) { $('console-search').open = true; throw new Error('Select a console or enter its IP address first.'); }
    status('Pairing with PSN. This can take a minute.');
    try {
      await api('psn/pair', { hostIp }, { timeout: 120000 });
      if (!active()) return;
      $('setup-dialog').close();
      await refresh();
      notify('Console paired. Select Play to connect.');
    } catch (error) {
      if (active()) $('manual-pairing').open = true;
      throw error;
    }
  });
  return {
    async restore() {
      const current = generation;
      try { const result = await api('psn/account'); if (current === generation) update(result.account); }
      catch { if (current === generation) status('Could not load your PSN account. You can still pair manually.'); }
    },
    select(console) {
      $('host-ip').value = console.ip;
      $('selected-console').textContent = `${console.name} · ${console.ip}`;
      $('setup-title').textContent = `Set up ${console.name}`;
      if (!$('setup-dialog').open) $('setup-dialog').showModal();
      if (account?.canAutoPair) $('auto-pair').focus();
      else $('psn-login').focus();
    },
    reset() {
      generation++;
      update(null);
      $('account-id').value = $('psn-redirect').value = $('psn-online-name').value = $('pin').value = $('host-ip').value = $('psn-copy-url').value = '';
      $('psn-login-link').removeAttribute('href');
      $('setup-title').textContent = 'Add a console';
      $('selected-console').textContent = 'Select a nearby console, or find it below.';
      $('console-search').open = $('manual-pairing').open = false;
      $('account-id-preview').hidden = $('psn-login-flow').hidden = true;
      $('setup-dialog').close();
      status('');
    }
  };
}
