import { SfCommand, Flags, StandardColors } from '@salesforce/sf-plugins-core';
import { Messages, Org, Connection } from '@salesforce/core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

Messages.importMessagesDirectory(path.join(__dirname, '..', '..', '..', 'messages'));
const messages = Messages.loadMessages('@beyondthecloud/sf-veles', 'veles.setup');

const MANAGED_NAMESPACE = 'btcveles';
const TEMPLATE_PERMSET = 'VelesHubIntegration';
const SEAT_GRANT_MARKER = 'SEAT_GRANT_RESULT:';
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 60;
export const GROUP_ON_SANDBOX_REFUSAL =
  '--group applies to scratch orgs only; sandbox memberships come from the Hub environment';
export const VELES_DEV_NOT_ASSIGNED = 'VelesDev permission set not assigned. Assign it to your user on the Hub org.';

export function hubRefusalOf(err: unknown): string | undefined {
  const message = (err as { message?: unknown } | undefined)?.message;
  if (typeof message !== 'string') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return undefined;
  }
  const body = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: unknown } | undefined;
  return typeof body?.error === 'string' ? body.error : undefined;
}

export function toSetupError(err: unknown, hubUrl: string): Error {
  const error = err as { statusCode?: number; errorCode?: string } | undefined;
  if (error?.statusCode === 401 || error?.errorCode === 'ERROR_HTTP_401') {
    return new Error(VELES_DEV_NOT_ASSIGNED);
  }
  const refusal = hubRefusalOf(err);
  if (!refusal) {
    return err instanceof Error ? err : new Error(String(err));
  }
  return new Error(`The Hub ${hubUrl} refused to connect this org: ${refusal}`);
}

function isNotFound(err: unknown): boolean {
  const error = err as { statusCode?: number; message?: string; errorCode?: string } | undefined;
  return error?.statusCode === 404
    || error?.errorCode === 'NOT_FOUND'
    || (error?.message ?? '').includes('Could not find a match for URL');
}

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

function formatElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

class StepRenderer {
  private readonly stream: NodeJS.WriteStream;
  private readonly animate: boolean;
  private readonly silent: boolean;
  private readonly color: boolean;
  private frame = 0;
  private timer: NodeJS.Timeout | null = null;
  private label = '';
  private status = '';
  private startedAt = 0;

  public constructor(stream: NodeJS.WriteStream, animate: boolean, silent: boolean, color: boolean) {
    this.stream = stream;
    this.animate = animate;
    this.silent = silent;
    this.color = color;
  }

  public start(label: string): void {
    this.label = label;
    this.status = '';
    this.startedAt = this.now();
    if (this.silent || !this.animate) {
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

  public setStatus(status: string): void {
    this.status = status;
    if (this.animate && !this.silent) {
      this.render();
    }
  }

  public succeed(label: string): void {
    if (this.silent) {
      return;
    }
    this.finish(`${this.c(GREEN)}✔${this.c(RESET)} ${label} ${this.c(DIM)}${this.elapsed()}${this.c(RESET)}\n`);
  }

  public fail(label: string, errMsg?: string): void {
    if (this.silent) {
      return;
    }
    let line = `${this.c(RED)}✖${this.c(RESET)} ${label} ${this.c(DIM)}${this.elapsed()}${this.c(RESET)}\n`;
    if (errMsg) {
      line += `  ${this.c(RED)}${errMsg}${this.c(RESET)}\n`;
    }
    this.finish(line);
  }

  public writeLine(line: string): void {
    if (this.silent) {
      return;
    }
    this.clearAnimatedLine();
    this.stream.write(`${line}\n`);
    if (this.timer) {
      this.render();
    }
  }

  public writePlain(line: string): void {
    if (this.silent) {
      return;
    }
    this.stream.write(`${line}\n`);
  }

  public paint(code: string): string {
    return this.c(code);
  }

  public stop(): void {
    this.clearAnimatedLine();
  }

  private c(code: string): string {
    return this.color ? code : '';
  }

  private render(): void {
    const cols = process.stdout.columns || 80;
    const glyph = SPINNER_FRAMES[this.frame];
    const plaintext = this.status ? `${this.label} ${this.status}` : this.label;
    const budget = Math.max(0, cols - RENDER_CHROME_COLUMNS);
    const clamped = plaintext.length > budget ? `${plaintext.slice(0, budget)}…` : plaintext;
    this.stream.write(`${CLEAR_LINE}${this.c(CYAN)}${glyph}${this.c(RESET)} ${this.c(GREY)}${clamped}${this.c(RESET)}`);
  }

  private finish(line: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.animate) {
      this.stream.write(CLEAR_LINE);
      this.stream.write(SHOW_CURSOR);
    }
    this.stream.write(line);
  }

  private clearAnimatedLine(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.animate) {
      this.stream.write(CLEAR_LINE);
      this.stream.write(SHOW_CURSOR);
    }
  }

  private elapsed(): string {
    return formatElapsed(this.now() - this.startedAt);
  }

  private now(): number {
    const [s, ns] = process.hrtime();
    return s * 1000 + ns / 1e6;
  }
}

interface ProvisionResponse {
  hubUrl: string;
  environmentName: string;
  packageVersionId?: string;
  hubIntegrationUsername?: string;
}

interface OrgQueryResult {
  Id: string;
  Name: string;
  IsSandbox: boolean;
  TrialExpirationDate: string | null;
}

export interface VelesSetupResult {
  environmentName: string;
  orgId: string;
  /**
   * @deprecated Always null in this and later versions: the Hub org id lives on the
   * protected `Environment__c` record and is not readable from a subscriber context.
   * Kept only for `--json` shape stability. Consumers should use `rssConfigured` instead.
   */
  hubOrgId: string | null;
  connected: boolean;
  rssConfigured: boolean;
  hubUrl: string;
}

export default class VelesSetup extends SfCommand<VelesSetupResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      char: 'o',
      summary: messages.getMessage('flags.target-org.summary'),
    }),
    'target-dev-hub': Flags.optionalHub({
      char: 'v',
      summary: messages.getMessage('flags.target-dev-hub.summary'),
    }),
    group: Flags.string({
      char: 'g',
      multiple: true,
      summary: messages.getMessage('flags.group.summary'),
    }),
    'installation-key': Flags.string({
      char: 'k',
      summary: messages.getMessage('flags.installation-key.summary'),
    }),
    'integration-permset': Flags.string({
      summary: messages.getMessage('flags.integration-permset.summary'),
      default: 'VelesIntegration',
    }),
    'integration-user': Flags.string({
      summary: messages.getMessage('flags.integration-user.summary'),
    }),
    verbose: Flags.boolean({
      summary: messages.getMessage('flags.verbose.summary'),
    }),
  };

  private namespace = MANAGED_NAMESPACE;
  private verbose = false;
  private renderer!: StepRenderer;

  public async run(): Promise<VelesSetupResult> {
    const { flags } = await this.parse(VelesSetup);
    this.verbose = flags.verbose as boolean;

    const json = this.jsonEnabled();
    const isTty = Boolean(process.stdout.isTTY);
    const animate = isTty && !json;
    const color = isTty && !process.env.NO_COLOR && !json;
    this.renderer = new StepRenderer(process.stdout, animate, json, color);
    const restoreCursor = (): void => this.renderer.stop();
    process.once('exit', restoreCursor);
    process.once('SIGINT', () => {
      restoreCursor();
      process.exit(130);
    });

    const targetOrg = flags['target-org'] as Org;
    const groupNames = (flags.group as string[] | undefined) ?? [];
    const installationKey = flags['installation-key'] as string | undefined;
    const integrationPermset = (flags['integration-permset'] as string) || 'VelesIntegration';
    const integrationUserOverride = flags['integration-user'] as string | undefined;

    this.stepStart('Resolving org & Hub');
    await targetOrg.refreshAuth();
    const targetConn = targetOrg.getConnection();
    const orgInfo = await this.queryOrgInfo(targetConn);
    const orgId = orgInfo.Id;
    const orgName = orgInfo.Name;
    const isSandbox = orgInfo.IsSandbox && orgInfo.TrialExpirationDate === null;
    const isScratchOrg = orgInfo.IsSandbox && orgInfo.TrialExpirationDate !== null;
    const orgTypeLabel = isSandbox ? 'Sandbox' : isScratchOrg ? 'Scratch Org' : 'Unknown';

    if (isSandbox && groupNames.length > 0) {
      this.stepFail('Resolving org & Hub');
      throw new Error(GROUP_ON_SANDBOX_REFUSAL);
    }

    this.detail(`Org ID: ${orgId}`);
    this.detail(`Org name: ${orgName}`);
    this.detail(`Org type: ${orgTypeLabel}`);

    const devhubOrg = (flags['target-dev-hub'] as Org | undefined) ?? (await this.resolveDevHub(targetOrg));
    await devhubOrg.refreshAuth();
    const devhubConn = devhubOrg.getConnection();

    const environmentLabel = isSandbox ? orgName : `${orgName} Scratch`;
    const environmentName = this.computeEnvironmentName(environmentLabel);
    this.detail(`Environment name: ${environmentName}`);

    const orgType = isSandbox ? 'SANDBOX' : undefined;
    const sandboxName = isSandbox ? this.resolveSandboxName(targetConn) : undefined;
    if (sandboxName) {
      this.detail(`Sandbox name: ${sandboxName}`);
    }

    const username = targetOrg.getUsername()!;
    const integrationUsername = integrationUserOverride ?? username;

    this.detail('Calling provision endpoint on Hub...');
    const provisionResponse = await this.callProvisionEndpoint(
      devhubConn,
      orgId,
      groupNames,
      environmentName,
      environmentLabel,
      orgType,
      integrationUsername,
      sandboxName,
    );
    this.stepOk(`Resolving org & Hub (${orgTypeLabel})`);

    this.stepStart('Installing Veles package');
    const alreadyInstalled = await this.checkPackageInstalled(targetConn);
    if (alreadyInstalled) {
      this.detail('Veles package already installed.');
      this.stepOk('Installing Veles package (already installed)');
    } else {
      let packageVersionId = provisionResponse.packageVersionId;
      if (!packageVersionId) {
        this.detail('Hub did not return a package version. Querying Hub for installed version...');
        packageVersionId = await this.queryInstalledPackageVersion(devhubConn);
        if (packageVersionId) {
          this.detail(`Found package version: ${packageVersionId}`);
        }
      }

      if (!packageVersionId) {
        this.stepFail('Installing Veles package');
        throw new Error(
          'No Veles package version found. Ensure the Veles package is installed on the Hub org.',
        );
      }

      try {
        await this.installPackage(username, packageVersionId, installationKey);
      } catch (err) {
        this.stepFail('Installing Veles package');
        throw err;
      }
      this.stepOk(`Installing Veles package (${packageVersionId})`);
    }

    this.stepStart('Deploying connection metadata');
    const tmpDir = this.buildRemoteSiteSettingsDir(provisionResponse);
    try {
      await this.deployToOrg(username, tmpDir);
    } catch (err) {
      this.stepFail('Deploying connection metadata');
      throw err;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    this.stepOk('Deploying connection metadata');

    this.stepStart('Configuring Hub connection');
    await this.configureHubUrl(username, provisionResponse.hubUrl);
    await this.configureDefaultIntegrationUsername(username, integrationUsername);

    if (provisionResponse.hubIntegrationUsername) {
      this.detail('Configuring Hub Integration Username...');
      await this.configureHubIntegrationUsername(username, provisionResponse.hubIntegrationUsername);
    } else {
      this.warnDuringStep('Hub did not return a Hub Integration Username — set manually in Setup Step 2.');
    }

    this.detail('Waiting for CMDT deployment...');
    await this.pollCmdtReady(username, 'isConfigReady');

    if (provisionResponse.hubIntegrationUsername) {
      this.detail('Waiting for Hub identity configuration...');
      await this.pollCmdtReady(username, 'isHubIdentityConfigured');
    }

    this.detail('Creating self-environment record...');
    await this.runApex(username, `${this.apexPrefix('VelesOrgSetup')}.ensureSelfEnvironment();`, 'create self-environment');

    this.detail('Marking setup as finished...');
    await this.runApex(username, `${this.apexPrefix('VelesOrgSetup')}.markSetupFinished();`, 'mark setup finished');

    this.detail('Waiting for setup to finalize...');
    await this.pollCmdtReady(username, 'isSetupFinished');
    this.stepOk('Configuring Hub connection');

    this.stepStart('Pre-authorizing integration user');
    await this.runEcaPreAuthAutomation(username, integrationUsername, integrationPermset);
    this.stepOk('Pre-authorizing integration user');

    this.stepStart('Connecting to Hub');
    this.detail('Triggering org connect...');
    await this.triggerConnect(username, groupNames);
    this.detail('Waiting for connection to complete...');
    const connected = await this.pollConnectionComplete(username);
    if (connected) {
      this.stepOk('Connecting to Hub');
    } else {
      this.stepFail('Connecting to Hub (timed out — may still complete)');
    }

    this.stepStart('Setting up environment (RSS)');
    const rssConfigured = await this.runEnvironmentSetupStep(username, devhubConn, targetConn, targetConn.instanceUrl);
    if (rssConfigured) {
      this.stepOk('Setting up environment (RSS)');
    } else {
      this.stepFail('Setting up environment (RSS)');
    }

    if (this.verbose) {
      this.printSummary({
        environmentName: provisionResponse.environmentName,
        orgId,
        hubOrgId: null,
        connected,
        rssConfigured,
        hubUrl: provisionResponse.hubUrl,
      });
    } else if (!this.jsonEnabled()) {
      this.renderer.writePlain(`\n${this.renderer.paint(GREEN)}Veles setup complete.${this.renderer.paint(RESET)}`);
    }

    return {
      environmentName: provisionResponse.environmentName,
      orgId,
      hubOrgId: null,
      connected,
      rssConfigured,
      hubUrl: provisionResponse.hubUrl,
    };
  }

  private stepStart(label: string): void {
    this.renderer.start(label);
  }

  private stepOk(label: string): void {
    this.renderer.succeed(label);
  }

  private stepFail(label: string, message?: string): void {
    this.renderer.fail(label, message);
  }

  private detail(message: string): void {
    if (!this.verbose) {
      return;
    }
    this.renderer.writeLine(`${this.renderer.paint(GREY)}${message}${this.renderer.paint(RESET)}`);
  }

  private warnDuringStep(message: string): void {
    this.renderer.writeLine(`${StandardColors.warning('Warning:')} ${message}`);
  }

  private setPollStatus(message: string): void {
    if (this.verbose) {
      this.renderer.writeLine(`${this.renderer.paint(GREY)}${message}${this.renderer.paint(RESET)}`);
    } else {
      this.renderer.setStatus(message);
    }
  }

  private printSummary(result: VelesSetupResult): void {
    this.styledHeader('Setup complete');
    this.styledObject({
      Environment: result.environmentName,
      'Org Id': result.orgId,
      'Hub→Child RSS': result.rssConfigured ? 'configured' : 'pending',
      Connection: result.connected ? 'connected' : 'not connected',
      'Hub URL': result.hubUrl,
    });
  }

  private async runEnvironmentSetupStep(
    username: string,
    devhubConn: Connection,
    targetConn: Connection,
    scratchInstanceUrl: string,
  ): Promise<boolean> {
    this.detail('Enqueuing environment setup (RSS)...');
    await this.waitForAsyncQueueIdle(targetConn);

    const setupSucceeded = await this.runEnvironmentSetupWithRetry(username);
    if (!setupSucceeded) {
      this.warnDuringStep(
        'Environment setup did not complete (a background job held a lock). The org is connected and usable — re-run `sf veles setup` or run "Setup Environment" from the Veles UI to finish.',
      );
      return false;
    }

    const target = this.normalizeUrl(scratchInstanceUrl);

    // ~3-min ceiling (60x3s) absorbs the async EnvironmentSetupJob's queue lag; on timeout we warn-not-fail because connect already succeeded, so the org is usable and the RSS is finishable from the Veles UI.
    for (let i = 1; i <= MAX_POLL_ATTEMPTS; i++) {
      if (await this.hubChildRssExists(devhubConn, target)) {
        return true;
      }
      this.setPollStatus(`waiting for RSS (${i}/${MAX_POLL_ATTEMPTS})`);
      await this.sleep(POLL_INTERVAL_MS);
    }

    this.warnDuringStep(
      'Hub→child Remote Site Setting did not confirm within the timeout. Re-run "Setup Environment" from the Veles UI to finish it; the org is connected and usable.',
    );
    return false;
  }

  private async waitForAsyncQueueIdle(targetConn: Connection): Promise<void> {
    for (let i = 1; i <= 24; i++) {
      const res = await targetConn.query(
        "SELECT COUNT() FROM AsyncApexJob WHERE Status IN ('Queued','Processing','Preparing')",
      );
      const pending = res.totalSize ?? 0;
      if (pending === 0) {
        return;
      }
      this.setPollStatus(`waiting on ${pending} background job${pending === 1 ? '' : 's'}`);
      await this.sleep(5000);
    }
    this.setPollStatus('background jobs still running, proceeding');
  }

  private async runEnvironmentSetupWithRetry(username: string): Promise<boolean> {
    const script = `${this.apexPrefix('VelesOrgSetup')}.runEnvironmentSetup('cli-env-setup');`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.runApex(username, script, 'run environment setup');
        return true;
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        if (!msg.includes('UNABLE_TO_LOCK_ROW') || attempt === 3) {
          return false;
        }
        this.setPollStatus(`retrying after lock (${attempt}/3)`);
        await this.sleep(5000);
      }
    }
    return false;
  }

  private async hubChildRssExists(devhubConn: Connection, normalizedTargetUrl: string): Promise<boolean> {
    if (!normalizedTargetUrl) {
      return false;
    }
    const base = this.escapeSoql(normalizedTargetUrl);
    const withSlash = this.escapeSoql(`${normalizedTargetUrl}/`);
    const soql = `SELECT EndpointUrl FROM RemoteProxy WHERE IsActive = true AND EndpointUrl IN ('${base}', '${withSlash}') LIMIT 1`;
    try {
      const result = await devhubConn.tooling.query<{ EndpointUrl: string }>(soql);
      return result.records.length > 0;
    } catch (err: unknown) {
      const error = err as { message?: string };
      this.detail(`Hub RemoteProxy query failed: ${error.message ?? 'unknown error'}`);
      return false;
    }
  }

  private normalizeUrl(url: string | null | undefined): string {
    if (!url) {
      return '';
    }
    const normalized = url.toLowerCase().trim();
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  }

  private escapeApexLiteral(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  private escapeSoql(value: string): string {
    return value.replace(/'/g, "\\'");
  }

  private async queryOrgInfo(conn: Connection): Promise<OrgQueryResult> {
    const result = await conn.query<OrgQueryResult>(
      'SELECT Id, Name, IsSandbox, TrialExpirationDate FROM Organization',
    );
    if (!result.records || result.records.length === 0) {
      throw new Error('Could not query Organization info from target org');
    }
    return result.records[0];
  }

  private resolveSandboxName(conn: Connection): string | undefined {
    const domain = conn.instanceUrl ?? '';
    const segment = domain.split('--')[1];
    if (!segment) {
      return undefined;
    }
    const name = segment.split('.')[0];
    return name ? name.toLowerCase() : undefined;
  }

  private async resolveDevHub(targetOrg: Org): Promise<Org> {
    try {
      const devHubOrg = await targetOrg.getDevHubOrg();
      if (devHubOrg) {
        return devHubOrg;
      }
    } catch {
    }

    const configAggregator = await targetOrg.getConfigAggregator().reload();
    const configDevHub = configAggregator.getPropertyValue('target-dev-hub');
    if (configDevHub && typeof configDevHub === 'string') {
      return Org.create({ aliasOrUsername: configDevHub });
    }

    throw new Error(
      'Could not resolve Hub/DevHub. Specify --target-dev-hub flag or set a default DevHub via sf config set target-dev-hub.',
    );
  }

  private computeEnvironmentName(label: string): string {
    return label
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_/, '')
      .replace(/_$/, '');
  }

  private async queryInstalledPackageVersion(conn: Connection): Promise<string | undefined> {
    try {
      const result = await conn.tooling.query<{
        Id: string;
        SubscriberPackage: { NamespacePrefix: string; Name: string };
        SubscriberPackageVersion: { Id: string };
      }>(
        'SELECT Id, SubscriberPackage.NamespacePrefix, SubscriberPackage.Name, SubscriberPackageVersion.Id FROM InstalledSubscriberPackage',
      );
      for (const record of result.records) {
        if (
          record.SubscriberPackage?.NamespacePrefix === MANAGED_NAMESPACE &&
          record.SubscriberPackage?.Name === 'Veles'
        ) {
          return record.SubscriberPackageVersion?.Id;
        }
      }
    } catch (err: unknown) {
      this.warnDuringStep(`Failed to query installed packages on Hub: ${(err as Error).message}`);
    }
    return undefined;
  }

  private async checkPackageInstalled(conn: Connection): Promise<boolean> {
    const result = await conn.tooling.query<{
      Id: string;
      SubscriberPackage: { NamespacePrefix: string; Name: string };
    }>(
      'SELECT Id, SubscriberPackage.NamespacePrefix, SubscriberPackage.Name FROM InstalledSubscriberPackage',
    );
    const installedAsPackage = result.records.some(
      (r) => r.SubscriberPackage?.NamespacePrefix === MANAGED_NAMESPACE && r.SubscriberPackage?.Name === 'Veles',
    );
    if (installedAsPackage) {
      return true;
    }

    const classResult = await conn.tooling.query<{ Id: string }>(
      `SELECT Id FROM ApexClass WHERE Name = 'VelesOrgSetup' AND (NamespacePrefix = '${MANAGED_NAMESPACE}' OR NamespacePrefix = null) LIMIT 1`,
    );
    return classResult.totalSize > 0;
  }

  private async installPackage(
    username: string,
    packageVersionId: string,
    installationKey?: string,
  ): Promise<void> {
    const args = [
      'package',
      'install',
      '--package',
      packageVersionId,
      '--target-org',
      username,
      '--wait',
      '15',
      '--no-prompt',
    ];
    if (installationKey) {
      args.push('--installation-key', installationKey);
    }
    try {
      await execFileAsync('sf', args, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      throw new Error(`Package installation failed: ${error.stdout || error.stderr || error.message}`);
    }
  }

  private buildProvisionBody(
    orgId: string,
    groupNames: string[],
    environmentName: string,
    environmentLabel: string,
    orgType: string | undefined,
    integrationUsername: string,
    sandboxName?: string,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      orgId,
      groupNames,
      environmentName,
      environmentLabel,
      integrationUsername,
    };
    if (orgType) {
      body.orgType = orgType;
    }
    if (sandboxName) {
      body.sandboxName = sandboxName;
    }
    return body;
  }

  private async callProvisionEndpoint(
    conn: Connection,
    orgId: string,
    groupNames: string[],
    environmentName: string,
    environmentLabel: string,
    orgType: string | undefined,
    integrationUsername: string,
    sandboxName?: string,
  ): Promise<ProvisionResponse> {
    const body = this.buildProvisionBody(
      orgId,
      groupNames,
      environmentName,
      environmentLabel,
      orgType,
      integrationUsername,
      sandboxName,
    );

    const namespacedPath = `/services/apexrest/${MANAGED_NAMESPACE}/veles/provision`;
    const unnamespacedPath = '/services/apexrest/veles/provision';

    let response: ProvisionResponse | undefined;

    try {
      response = await this.postToEndpoint(conn, namespacedPath, body);
    } catch (err: unknown) {
      if (!isNotFound(err)) {
        throw toSetupError(err, conn.instanceUrl);
      }
      this.namespace = '';
      try {
        response = await this.postToEndpoint(conn, unnamespacedPath, body);
      } catch (fallbackErr: unknown) {
        throw toSetupError(fallbackErr, conn.instanceUrl);
      }
    }

    if (!response) {
      throw new Error('Empty response from provision endpoint');
    }

    return response;
  }

  private async postToEndpoint(
    conn: Connection,
    urlPath: string,
    body: Record<string, unknown>,
  ): Promise<ProvisionResponse> {
    const result = await conn.request({
      method: 'POST',
      url: urlPath,
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });

    const parsed = typeof result === 'string' ? JSON.parse(result) : result;

    if (parsed.error) {
      const error = new Error(parsed.error) as Error & { statusCode?: number };
      error.statusCode = parsed.statusCode ?? 400;
      throw error;
    }

    return parsed as ProvisionResponse;
  }

  private buildRemoteSiteSettingsDir(response: ProvisionResponse): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veles-setup-'));

    const projectJson = {
      packageDirectories: [{ path: 'src', default: true }],
      sourceApiVersion: '66.0',
    };
    fs.writeFileSync(path.join(tmpDir, 'sfdx-project.json'), JSON.stringify(projectJson, null, 2));

    const rssDir = path.join(tmpDir, 'src', 'remoteSiteSettings');
    fs.mkdirSync(rssDir, { recursive: true });

    const hubUrlClean = response.hubUrl.replace(/\/$/, '');

    fs.writeFileSync(
      path.join(rssDir, 'VelesHubUrl.remoteSite-meta.xml'),
      `<?xml version="1.0" encoding="UTF-8" ?>
<RemoteSiteSetting xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>VelesHubUrl</fullName>
    <isActive>true</isActive>
    <url>${this.escapeXml(hubUrlClean)}</url>
    <description>Veles Hub URL</description>
</RemoteSiteSetting>`,
    );

    return tmpDir;
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private async deployToOrg(username: string, projectDir: string): Promise<void> {
    const args = [
      'project',
      'deploy',
      'start',
      '--source-dir',
      'src',
      '--target-org',
      username,
      '--ignore-conflicts',
    ];
    const opts = { cwd: projectDir, encoding: 'utf-8' as const, maxBuffer: 10 * 1024 * 1024 };

    try {
      await execFileAsync('sf', args, opts);
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      this.detail('First deploy attempt failed, retrying...');
      try {
        await execFileAsync('sf', args, opts);
      } catch (retryErr: unknown) {
        const retry = retryErr as { stdout?: string; stderr?: string; message?: string };
        const detail = retry.stdout || retry.stderr || retry.message || error.message || 'Unknown error';
        throw new Error(`Deploy failed: ${detail}`);
      }
    }
  }

  private apexPrefix(name: string): string {
    return this.namespace ? `${this.namespace}.${name}` : name;
  }

  private async pollCmdtReady(username: string, method: string): Promise<void> {
    const matched = await this.pollApexCondition(
      username,
      `${this.apexPrefix('VelesOrgSetup')}.${method}()`,
      'Waiting...',
    );
    if (!matched) {
      throw new Error(`${method}() did not return true within expected time.`);
    }
    this.detail('  Done.');
  }

  private async configureHubUrl(username: string, hubUrl: string): Promise<void> {
    const escapedUrl = this.escapeApexLiteral(hubUrl);
    await this.runApex(username, `${this.apexPrefix('VelesOrgSetup')}.configureHubUrl('${escapedUrl}');`, 'configure Hub URL');
  }

  private async configureHubIntegrationUsername(username: string, hubIntegrationUsername: string): Promise<void> {
    const escaped = this.escapeApexLiteral(hubIntegrationUsername);
    await this.runApex(
      username,
      `${this.apexPrefix('VelesOrgSetup')}.configureHubIntegrationUsername('${escaped}');`,
      'configure Hub Integration Username',
    );
  }

  private async configureDefaultIntegrationUsername(username: string, integrationUsername: string): Promise<void> {
    const escaped = this.escapeApexLiteral(integrationUsername);
    await this.runApex(
      username,
      `${this.apexPrefix('VelesOrgSetup')}.configureDefaultIntegrationUsername('${escaped}');`,
      'configure Default Integration Username',
    );
  }

  private buildTriggerConnectScript(groupNames: string[]): string {
    const literals = groupNames.map((name) => `'${this.escapeApexLiteral(name)}'`).join(', ');
    return `${this.apexPrefix('VelesOrgSetup')}.setupOrg(new List<String>{ ${literals} });`;
  }

  private async triggerConnect(username: string, groupNames: string[]): Promise<void> {
    await this.runApex(username, this.buildTriggerConnectScript(groupNames), 'trigger connect');
  }

  private async runApexFile(username: string, script: string, jsonFlag: boolean): Promise<string> {
    const tmpFile = path.join(os.tmpdir(), `veles-apex-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.apex`);
    fs.writeFileSync(tmpFile, script);
    try {
      const args = ['apex', 'run', '--target-org', username];
      if (jsonFlag) {
        args.push('--json');
      }
      args.push('--file', tmpFile);
      const { stdout } = await execFileAsync('sf', args, { encoding: 'utf-8' });
      return stdout;
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  }

  private async runApex(username: string, script: string, operationName: string): Promise<void> {
    try {
      await this.runApexFile(username, script, true);
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      throw new Error(`Failed to ${operationName}: ${error.stdout || error.stderr || error.message}`);
    }
  }

  private async pollConnectionComplete(username: string): Promise<boolean> {
    const connected = await this.pollApexCondition(
      username,
      `${this.apexPrefix('VelesOrgSetup')}.isConnectionComplete()`,
      'waiting for connection',
    );
    if (connected) {
      this.detail('  Connection established successfully.');
    }
    return connected;
  }

  private async pollApexCondition(username: string, expression: string, waitMessage: string): Promise<boolean> {
    const marker = 'POLL_CHECK';
    const checkScript = `System.debug('${marker}=' + ${expression});`;

    for (let i = 1; i <= MAX_POLL_ATTEMPTS; i++) {
      try {
        const result = await this.runApexFile(username, checkScript, true);

        if (result.includes(`${marker}=true`)) {
          return true;
        }
      } catch {
      }

      this.setPollStatus(`${waitMessage} (attempt ${i}/${MAX_POLL_ATTEMPTS})`);
      await this.sleep(POLL_INTERVAL_MS);
    }

    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async runEcaPreAuthAutomation(
    targetOrgUsername: string,
    integrationUsername: string,
    integrationPermsetName: string,
  ): Promise<void> {
    this.detail('Cloning the Veles Hub Integration permission set into an unmanaged copy...');
    try {
      await this.deployIntegrationClone(targetOrgUsername, integrationPermsetName);
    } catch (err) {
      this.warnDuringStep(`Integration permission set clone failed: ${(err as Error).message}`);
      return;
    }

    this.detail('Assigning the integration permission set to the integration user...');
    try {
      await this.assignPermsets(targetOrgUsername, integrationUsername, integrationPermsetName);
    } catch (err) {
      this.warnDuringStep(`Integration permission set assignment failed: ${(err as Error).message}`);
    }

    try {
      await this.grantVelesSeat(targetOrgUsername, integrationUsername);
    } catch (err) {
      this.warnDuringStep(`Veles seat grant failed: ${(err as Error).message}`);
    }

    this.detail('Configuring ECA pre-authorization...');
    try {
      const ecaName = await this.resolveEcaName(targetOrgUsername);
      if (!ecaName) {
        throw new Error('Could not resolve the Veles ECA in target org.');
      }
      this.detail(`  Resolved ECA: ${ecaName}`);
      await this.flipEcaToPreAuthorized(targetOrgUsername, ecaName);
      await this.grantEcaAccessToPermset(targetOrgUsername, ecaName, integrationPermsetName);
    } catch (err) {
      this.warnDuringStep(`ECA pre-authorization failed: ${(err as Error).message}`);
    }
  }

  private async deployIntegrationClone(targetOrgUsername: string, cloneName: string): Promise<void> {
    const templateFullName = await this.resolveTemplatePermsetFullName(targetOrgUsername);
    const templateXml = await this.retrieveTemplatePermsetXml(targetOrgUsername, templateFullName);
    const cloneXml = this.renameClonePermset(templateXml, cloneName);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veles-integration-permset-'));
    try {
      const projectJson = {
        packageDirectories: [{ path: 'src', default: true }],
        sourceApiVersion: '66.0',
      };
      fs.writeFileSync(path.join(tmpDir, 'sfdx-project.json'), JSON.stringify(projectJson, null, 2));
      const psDir = path.join(tmpDir, 'src', 'permissionsets');
      fs.mkdirSync(psDir, { recursive: true });
      fs.writeFileSync(path.join(psDir, `${cloneName}.permissionset-meta.xml`), cloneXml);

      await this.deployToOrg(targetOrgUsername, tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private async resolveTemplatePermsetFullName(targetOrgUsername: string): Promise<string> {
    const script = `
List<PermissionSet> ps = [SELECT Name, NamespacePrefix FROM PermissionSet WHERE Name = '${TEMPLATE_PERMSET}' ORDER BY NamespacePrefix NULLS LAST LIMIT 1];
System.debug('TEMPLATE_PERMSET_FULLNAME:' + (ps.isEmpty() ? 'null' : (String.isBlank(ps[0].NamespacePrefix) ? ps[0].Name : ps[0].NamespacePrefix + '__' + ps[0].Name)));
`.trim();

    const stdout = await this.runApexCapture(targetOrgUsername, script, 'resolve template permset');
    const match = stdout.match(/TEMPLATE_PERMSET_FULLNAME:([A-Za-z0-9_]+)/);
    if (!match || match[1] === 'null') {
      throw new Error(
        'Packaged "Veles Hub Integration" permission set not found on the target org. Reinstall the Veles package if it is missing.',
      );
    }
    return match[1];
  }

  private async retrieveTemplatePermsetXml(targetOrgUsername: string, templateFullName: string): Promise<string> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veles-permset-retrieve-'));
    try {
      const projectJson = {
        packageDirectories: [{ path: 'src', default: true }],
        sourceApiVersion: '66.0',
      };
      fs.writeFileSync(path.join(tmpDir, 'sfdx-project.json'), JSON.stringify(projectJson, null, 2));
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

      const { stdout: retrieveOut } = await execFileAsync(
        'sf',
        ['project', 'retrieve', 'start', '--metadata', `PermissionSet:${templateFullName}`, '--target-org', targetOrgUsername],
        { cwd: tmpDir, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
      );

      const files = this.collectFiles(tmpDir);
      const retrieved = files.find((f) => f.endsWith(`${TEMPLATE_PERMSET}.permissionset-meta.xml`));
      if (!retrieved) {
        throw new Error(
          `${TEMPLATE_PERMSET} permset was not retrieved from the org.\nRetrieve output:\n${retrieveOut}\nFiles written:\n  ${
            files.join('\n  ') || '(none)'
          }`,
        );
      }
      return fs.readFileSync(retrieved, 'utf-8');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private renameClonePermset(xml: string, cloneName: string): string {
    // The packaged template is already least-privilege (VelesApi class access
    // only), so there is nothing to strip — the clone exists purely because the
    // ECA pre-authorized-permission-sets picker rejects a managed/packaged set.
    const label = this.escapeXml(this.humanizeLabel(cloneName));
    return xml.replace(/<label>[^<]*<\/label>/, `<label>${label}</label>`);
  }

  private humanizeLabel(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  }

  private collectFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.collectFiles(full, acc);
      } else {
        acc.push(full);
      }
    }
    return acc;
  }

  private async assignPermsets(
    targetOrgUsername: string,
    integrationUsername: string,
    integrationPermsetName: string,
  ): Promise<void> {
    const escapedUser = this.escapeApexLiteral(integrationUsername);
    const escapedPermset = this.escapeApexLiteral(integrationPermsetName);
    const script = `
List<User> users = [SELECT Id FROM User WHERE Username = '${escapedUser}' LIMIT 1];
if (users.isEmpty()) { throw new System.IllegalArgumentException('No user found with username ${escapedUser}'); }
Id userId = users[0].Id;
List<PermissionSet> permsets = [SELECT Id FROM PermissionSet WHERE Name = '${escapedPermset}' AND NamespacePrefix = null LIMIT 1];
if (permsets.isEmpty()) { throw new System.IllegalArgumentException('No unmanaged permission set named ${escapedPermset}'); }
Id permsetId = permsets[0].Id;
Integer existing = [SELECT COUNT() FROM PermissionSetAssignment WHERE AssigneeId = :userId AND PermissionSetId = :permsetId];
if (existing == 0) { insert new PermissionSetAssignment(AssigneeId = userId, PermissionSetId = permsetId); }
System.debug('PERMSET_ASSIGN_DONE: assigned=' + (existing == 0));
`.trim();

    await this.runApex(targetOrgUsername, script, 'assign integration permset');
  }

  private async grantVelesSeat(targetOrgUsername: string, integrationUsername: string): Promise<void> {
    const script = this.buildSeatGrantScript(integrationUsername, this.namespace);
    if (!script) {
      return;
    }
    this.detail('Granting a Veles seat to the integration user...');
    const stdout = await this.runApexCapture(targetOrgUsername, script, 'grant Veles seat');
    const remediation = this.parseSeatGrantOutcome(stdout);
    if (remediation) {
      this.warnDuringStep(remediation);
    }
  }

  private buildSeatGrantScript(integrationUsername: string, namespace: string): string | null {
    if (!namespace) {
      return null;
    }
    const escapedUser = this.escapeApexLiteral(integrationUsername);
    return `
String outcome = ${namespace}.VelesOrgSetup.assignVelesSeat('${escapedUser}');
System.debug('${SEAT_GRANT_MARKER}' + (outcome == null ? '' : outcome));
`.trim();
  }

  private parseSeatGrantOutcome(stdout: string): string | null {
    const match = stdout.match(new RegExp(`${SEAT_GRANT_MARKER}(.*)`));
    const outcome = match ? match[1].trim() : '';
    return outcome || null;
  }

  private async resolveEcaName(targetOrgUsername: string): Promise<string | null> {
    // DeveloperName on ExternalClientApplication is unqualified; the namespace
    // is a separate column, so filter on both rather than a composed name.
    const nsFilter = this.namespace ? `NamespacePrefix = '${this.namespace}'` : 'NamespacePrefix = null';
    const script = `
List<ExternalClientApplication> ecas = [SELECT DeveloperName FROM ExternalClientApplication WHERE DeveloperName IN ('Veles_Test', 'Veles_Prod') AND ${nsFilter} ORDER BY DeveloperName ASC];
System.debug('ECA_RESOLVED:' + (ecas.isEmpty() ? 'null' : ecas[0].DeveloperName));
`.trim();

    const stdout = await this.runApexCapture(targetOrgUsername, script, 'resolve ECA name');
    const match = stdout.match(/ECA_RESOLVED:([A-Za-z0-9_]+)/);
    if (!match || match[1] === 'null') {
      return null;
    }
    return match[1];
  }

  private async flipEcaToPreAuthorized(targetOrgUsername: string, ecaDeveloperName: string): Promise<void> {
    // The subscriber-editable pre-auth policy of an installed ECA lives in
    // ExtlClntAppOauthConfigurablePolicies, member <eca>_oauth_defaultPolicy.
    // The member name is unqualified even though the policy references the
    // namespaced ECA. ExtlClntAppOauthSettings is packaged and not retrievable.
    const policyFullName = `${ecaDeveloperName}_oauth_defaultPolicy`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veles-eca-oauth-'));
    try {
      const projectJson = {
        packageDirectories: [{ path: 'src', default: true }],
        sourceApiVersion: '66.0',
      };
      fs.writeFileSync(path.join(tmpDir, 'sfdx-project.json'), JSON.stringify(projectJson, null, 2));
      fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

      try {
        await execFileAsync(
          'sf',
          ['project', 'retrieve', 'start', '--metadata', `ExtlClntAppOauthConfigurablePolicies:${policyFullName}`, '--target-org', targetOrgUsername],
          { cwd: tmpDir, encoding: 'utf-8' },
        );
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        throw new Error(
          `Could not retrieve ExtlClntAppOauthConfigurablePolicies:${policyFullName}: ${e.stdout || e.stderr || e.message}`,
        );
      }

      const file = this.collectFiles(tmpDir).find((f) => f.endsWith('.ecaOauthPlcy-meta.xml'));
      if (!file) {
        throw new Error(
          `Retrieved ECA OAuth policy file not found for ${policyFullName} under ${tmpDir}. Retrieved: ${this.collectFiles(tmpDir).join(', ') || '(none)'}`,
        );
      }

      const xml = fs.readFileSync(file, 'utf-8');
      const patched = this.patchPermittedUsersPolicy(xml, 'AdminApprovedPreAuthorized');
      fs.writeFileSync(file, patched);

      await this.deployToOrg(targetOrgUsername, tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private patchPermittedUsersPolicy(xml: string, value: string): string {
    if (xml.includes('<permittedUsersPolicyType>')) {
      return xml.replace(
        /<permittedUsersPolicyType>[^<]*<\/permittedUsersPolicyType>/,
        `<permittedUsersPolicyType>${value}</permittedUsersPolicyType>`,
      );
    }
    return xml.replace(
      /(<isClientCredentialsFlowEnabled>[^<]*<\/isClientCredentialsFlowEnabled>|<isCodeCredentialsFlowEnabled>[^<]*<\/isCodeCredentialsFlowEnabled>|<\/ExtlClntAppOauthConfigurablePolicies>)/,
      `<permittedUsersPolicyType>${value}</permittedUsersPolicyType>$1`,
    );
  }

  private async grantEcaAccessToPermset(
    targetOrgUsername: string,
    ecaDeveloperName: string,
    integrationPermsetName: string,
  ): Promise<void> {
    const escapedEca = this.escapeApexLiteral(ecaDeveloperName);
    const escapedPermset = this.escapeApexLiteral(integrationPermsetName);
    const nsFilter = this.namespace ? `NamespacePrefix = '${this.namespace}'` : 'NamespacePrefix = null';
    const script = `
Id ecaId = [SELECT Id FROM ExternalClientApplication WHERE DeveloperName = '${escapedEca}' AND ${nsFilter} LIMIT 1].Id;
List<PermissionSet> permsets = [SELECT Id FROM PermissionSet WHERE Name = '${escapedPermset}' AND NamespacePrefix = null LIMIT 1];
if (permsets.isEmpty()) { throw new System.IllegalArgumentException('No unmanaged permission set named ${escapedPermset}'); }
Id permsetId = permsets[0].Id;
Integer existing = [SELECT COUNT() FROM SetupEntityAccess WHERE SetupEntityType = 'ExternalClientApplication' AND SetupEntityId = :ecaId AND ParentId = :permsetId];
if (existing == 0) {
    insert new SetupEntityAccess(SetupEntityId = ecaId, ParentId = permsetId);
}
System.debug('ECA_PREAUTH_DONE: ecaId=' + ecaId + ' alreadyExisted=' + (existing > 0));
`.trim();
    await this.runApex(targetOrgUsername, script, 'grant ECA access to permset');
  }

  private async runApexCapture(username: string, script: string, operationName: string): Promise<string> {
    try {
      return await this.runApexFile(username, script, false);
    } catch (err) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      throw new Error(`Failed to ${operationName}: ${error.stdout || error.stderr || error.message}`);
    }
  }

}
