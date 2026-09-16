export function bindSessionTabs() {
  const tabs = [...document.querySelectorAll('#session-tabs [role=tab]')];
  const select = id => {
    for (const tab of tabs) {
      const selected = tab.getAttribute('aria-controls') === id;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
    }
  };
  for (const tab of tabs) {
    tab.onclick = () => select(tab.getAttribute('aria-controls'));
    tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const enabled = tabs.filter(item => !item.disabled);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 :
        (enabled.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
      enabled[index].focus(); enabled[index].click();
    };
  }
  return select;
}
