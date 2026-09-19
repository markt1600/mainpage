export const sources = ['youtube', 'memories', 'game', 'cna', 'aqi', 'webcam'];

export function createRotation({current, select, changed, schedule = setTimeout, cancel = clearTimeout}) {
  let enabled = false, timer;
  function arm() {
    timer = schedule(() => {
      if (!enabled) return;
      select(sources[(sources.indexOf(current()) + 1) % sources.length]);
      arm();
    }, 300000);
  }
  function setEnabled(value) {
    cancel(timer);
    enabled = value;
    changed(enabled);
    if (enabled) arm();
  }
  return {
    setEnabled,
    toggle: () => setEnabled(!enabled),
    manual: value => { setEnabled(false); select(value); }
  };
}
