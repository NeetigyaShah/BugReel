class BugReelPlayer extends HTMLElement {}

if (typeof customElements !== 'undefined' && !customElements.get('bugreel-player')) {
  customElements.define('bugreel-player', BugReelPlayer);
}

export { BugReelPlayer };
