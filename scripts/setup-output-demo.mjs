#!/usr/bin/env node

const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const GREY = '\x1b[90m';
const DIM = '\x1b[2m';
const CLEAR_LINE = '\x1b[2K\r';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;

const GLYPH_COLUMN = 1;
const GLYPH_SEPARATOR_COLUMN = 1;
const ELLIPSIS_COLUMN = 1;
const WRAP_SAFETY_MARGIN_COLUMN = 1;
const RENDER_CHROME_COLUMNS = GLYPH_COLUMN + GLYPH_SEPARATOR_COLUMN + ELLIPSIS_COLUMN + WRAP_SAFETY_MARGIN_COLUMN;

const LONG_STATUS_STAGE = 'Setting up environment (RSS)';
const LONG_STATUS = 'waiting on 1 background job (resolving org and hub, deploying connection metadata, configuring hub)';
const LONG_STATUS_INTERVAL_MS = 500;
const LONG_STATUS_DURATION_MS = 4000;

const STAGES = [
  'Resolving org & Hub',
  'Installing Veles package',
  'Deploying connection metadata',
  'Configuring Hub connection',
  'Pre-authorizing integration user',
  'Connecting to Hub',
  'Setting up environment (RSS)',
];

function parseArgs(argv) {
  const opts = { delay: 2000, failAt: null, longStatus: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--delay') {
      opts.delay = Number(argv[++i]);
    } else if (arg === '--fail-at') {
      opts.failAt = Number(argv[++i]);
    } else if (arg === '--long-status') {
      opts.longStatus = true;
    }
  }
  return opts;
}

function formatElapsed(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class StepRenderer {
  constructor(stream = process.stdout) {
    this.stream = stream;
    this.isTty = Boolean(stream.isTTY);
    this.frame = 0;
    this.timer = null;
    this.label = '';
    this.status = '';
    this.startedAt = 0;
  }

  start(label) {
    this.label = label;
    this.status = '';
    this.startedAt = this.now();
    if (!this.isTty) {
      return;
    }
    this.stream.write(HIDE_CURSOR);
    this.frame = 0;
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, SPINNER_INTERVAL_MS);
  }

  setStatus(status) {
    this.status = status;
    if (this.isTty) {
      this.render();
    }
  }

  succeed(label) {
    this.finish(`${GREEN}✔${RESET} ${label} ${DIM}${this.elapsed()}${RESET}\n`);
  }

  fail(label, errMsg) {
    let line = `${RED}✖${RESET} ${label} ${DIM}${this.elapsed()}${RESET}\n`;
    if (errMsg) {
      line += `  ${RED}${errMsg}${RESET}\n`;
    }
    this.finish(line);
  }

  render() {
    const cols = process.stdout.columns || 80;
    const glyph = SPINNER_FRAMES[this.frame];
    const plaintext = this.status ? `${this.label} ${this.status}` : this.label;
    const budget = Math.max(0, cols - RENDER_CHROME_COLUMNS);
    const clamped = plaintext.length > budget ? `${plaintext.slice(0, budget)}…` : plaintext;
    this.stream.write(`${CLEAR_LINE}${CYAN}${glyph}${RESET} ${GREY}${clamped}${RESET}`);
  }

  finish(line) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.isTty) {
      this.stream.write(CLEAR_LINE);
      this.stream.write(SHOW_CURSOR);
    }
    this.stream.write(line);
  }

  elapsed() {
    return formatElapsed(this.now() - this.startedAt);
  }

  now() {
    const [s, ns] = process.hrtime();
    return s * 1000 + ns / 1e6;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.isTty) {
      this.stream.write(CLEAR_LINE);
      this.stream.write(SHOW_CURSOR);
    }
  }
}

async function runLongStatusStage(renderer, label) {
  renderer.start(label);
  const deadline = Date.now() + LONG_STATUS_DURATION_MS;
  let dots = 0;
  while (Date.now() < deadline) {
    dots = (dots % 3) + 1;
    renderer.setStatus(`${LONG_STATUS}${'.'.repeat(dots)}`);
    await sleep(LONG_STATUS_INTERVAL_MS);
  }
  renderer.succeed(label);
}

async function main() {
  const { delay, failAt, longStatus } = parseArgs(process.argv.slice(2));
  const renderer = new StepRenderer();

  const onExit = () => renderer.stop();
  process.on('SIGINT', () => {
    onExit();
    process.exit(130);
  });
  process.on('exit', onExit);

  for (let i = 0; i < STAGES.length; i++) {
    const label = STAGES[i];
    const stageNumber = i + 1;

    if (longStatus && label === LONG_STATUS_STAGE) {
      await runLongStatusStage(renderer, label);
      continue;
    }

    renderer.start(label);
    await sleep(delay);

    if (failAt === stageNumber) {
      renderer.fail(label, `Stage ${stageNumber} failed: simulated error for preview.`);
      return;
    }
    renderer.succeed(label);
  }

  process.stdout.write(`\n${GREEN}Veles setup complete.${RESET}\n`);
}

main();
