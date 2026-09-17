const EventEmitter = require('events');

// One bus per "channel" (e.g. 'server' console output, 'install' steamcmd output,
// 'mods' mod-import progress). Keeps a ring buffer so a client connecting to the
// SSE stream mid-run still sees recent history.
class LogBus extends EventEmitter {
  constructor(maxLines = 500) {
    super();
    this.maxLines = maxLines;
    this.lines = [];
  }

  push(line) {
    const entry = { time: new Date().toISOString(), line };
    this.lines.push(entry);
    if (this.lines.length > this.maxLines) {
      this.lines.shift();
    }
    this.emit('line', entry);
  }

  history() {
    return this.lines;
  }

  clear() {
    this.lines = [];
  }
}

const buses = {
  server: new LogBus(500),
  install: new LogBus(500),
  mods: new LogBus(500)
};

function getBus(channel) {
  if (!buses[channel]) buses[channel] = new LogBus(500);
  return buses[channel];
}

module.exports = { getBus };
