const titles = {
  'video-mode': ['Automatic', 'H.264', 'H.265', 'Canvas'],
  'resolution-profile': ['360p', '540p', '720p', '1080p'],
  'frame-pacing': ['Smooth', 'Responsive'],
  'audio-delay': ['40 ms', '120 ms', '240 ms'],
  'controller-mode': ['Automatic', 'Physical', 'Tesla virtual'],
  'controller-swap': ['Automatic', 'On', 'Off']
};
const codecArt = { auto: '/art/codec-auto.svg', h264: '/art/codec-h264.svg', h265: '/art/codec-h265.svg', mpeg1: '/art/codec-canvas.svg' };
const hudArt = { detailed: '/art/hud-detailed.svg', minimal: '/art/hud-minimal.svg', horizontal: '/art/hud-horizontal.svg' };
const codecDescriptions = { auto: 'Best available', h264: 'Browser', h265: 'PS5 · browser', mpeg1: 'Software' };

export function bindChoiceButtons(root = document) {
  const groups = [];
  for (const select of root.querySelectorAll('#profile-settings select, #audio-controls select, .controller-settings select, .hud-settings select')) {
    const label = select.labels[0];
    const name = [...label.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim();
    const field = document.createElement('fieldset');
    field.className = `choice-field ${select.id === 'video-mode' ? 'codec-field' : ''}`;
    field.dataset.choiceFor = select.id;
    const legend = document.createElement('legend'); legend.textContent = name; legend.id = `${select.id}-legend`;
    const group = document.createElement('div'); group.className = 'choice-buttons';
    group.setAttribute('role', 'radiogroup'); group.setAttribute('aria-labelledby', legend.id);
    if (select.getAttribute('aria-describedby')) group.setAttribute('aria-describedby', select.getAttribute('aria-describedby'));
    group.dataset.count = select.options.length;
    const buttons = [...select.options].map((option, index) => {
      const button = document.createElement('button'); button.type = 'button';
      button.setAttribute('role', 'radio'); button.dataset.value = option.value;
      const title = titles[select.id]?.[index] || option.textContent.split(' · ')[0];
      button.setAttribute('aria-label', title);
      if (select.id === 'video-mode') {
        const icon = document.createElement('img'); icon.src = codecArt[option.value]; icon.width = 32; icon.height = 32; icon.alt = '';
        const text = document.createElement('strong'); text.textContent = title;
        const detail = document.createElement('small'); detail.textContent = codecDescriptions[option.value];
        button.append(icon, text, detail);
      } else if (select.id === 'hud-style') {
        const icon = document.createElement('img'); icon.src = hudArt[option.value]; icon.width = 48; icon.height = 28; icon.alt = '';
        const text = document.createElement('span'); text.textContent = title;
        button.append(icon, text);
      } else button.textContent = title;
      button.onclick = () => {
        if (select.value === option.value) return;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };
      group.append(button);
      return button;
    });
    group.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      let index = buttons.indexOf(document.activeElement);
      if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = buttons.length - 1;
      else index = (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index].focus(); buttons[index].click();
    });
    if (label.contains(select)) label.replaceWith(field);
    else { select.before(field); label.remove(); }
    select.hidden = true; select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    field.append(legend, select, group);
    groups.push({ select, buttons });
  }
  const sync = () => {
    for (const { select, buttons } of groups) for (const button of buttons) {
      const selected = button.dataset.value === select.value;
      button.setAttribute('aria-checked', String(selected)); button.tabIndex = selected ? 0 : -1;
      button.disabled = select.disabled;
    }
  };
  root.addEventListener('change', sync);
  sync();
  return sync;
}
