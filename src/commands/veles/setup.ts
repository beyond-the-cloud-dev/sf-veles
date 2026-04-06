import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages, Org, Connection } from '@salesforce/core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

Messages.importMessagesDirectory(path.join(__dirname, '..', '..', '..', 'messages'));
const messages = Messages.loadMessages('@beyondthecloud/sf-veles', 'veles.setup');

const MANAGED_NAMESPACE = 'btcveles';
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 60;

interface ProvisionResponse {
  environmentToken: string;
  hubUrl: string;
  publicSitePath: string;
  environmentName: string;
  packageVersionId?: string;
}

interface OrgQueryResult {
  Id: string;
  Name: string;
  IsSandbox: boolean;
  TrialExpirationDate: string | null;
}

export default class VelesSetup extends SfCommand<void> {
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
      summary: messages.getMessage('flags.group.summary'),
    }),
    'installation-key': Flags.string({
      char: 'k',
      summary: messages.getMessage('flags.installation-key.summary'),
    }),
  };

  private namespace = MANAGED_NAMESPACE;

  public async run(): Promise<void> {
    const { flags } = await this.parse(VelesSetup);

    const targetOrg = flags['target-org'] as Org;
    const groupName = flags.group as string | undefined;
    const installationKey = flags['installation-key'] as string | undefined;

    this.log('Resolving target org...');
    await targetOrg.refreshAuth();
    const targetConn = targetOrg.getConnection();
    const orgInfo = await this.queryOrgInfo(targetConn);
    const orgId = orgInfo.Id;
    const orgName = orgInfo.Name;
    const isSandbox = orgInfo.IsSandbox && orgInfo.TrialExpirationDate === null;
    const isScratchOrg = orgInfo.IsSandbox && orgInfo.TrialExpirationDate !== null;

    this.log(`Org ID: ${orgId}`);
    this.log(`Org name: ${orgName}`);
    this.log(`Org type: ${isSandbox ? 'Sandbox' : isScratchOrg ? 'Scratch Org' : 'Unknown'}`);

    let devhubOrg: Org;
    let devhubConn: Connection;

    if (isSandbox) {
      this.log('Resolving Hub org...');
      devhubOrg = (flags['target-dev-hub'] as Org | undefined) ?? (await this.resolveDevHub(targetOrg));
      await devhubOrg.refreshAuth();
      devhubConn = devhubOrg.getConnection();
    } else {
      this.log('Resolving DevHub...');
      devhubOrg = (flags['target-dev-hub'] as Org | undefined) ?? (await this.resolveDevHub(targetOrg));
      await devhubOrg.refreshAuth();
      devhubConn = devhubOrg.getConnection();
    }

    const environmentLabel = isSandbox ? orgName : `${orgName} Scratch`;
    const environmentName = this.computeEnvironmentName(environmentLabel);
    this.log(`Environment name: ${environmentName}`);

    const orgType = isSandbox ? 'SANDBOX' : undefined;

    this.log('Calling provision endpoint on Hub...');
    const provisionResponse = await this.callProvisionEndpoint(
      devhubConn,
      orgId,
      groupName,
      environmentName,
      environmentLabel,
      orgType,
    );

    const username = targetOrg.getUsername()!;

    const alreadyInstalled = await this.checkPackageInstalled(targetConn);
    if (alreadyInstalled) {
      this.log('Veles package already installed.');
    } else {
      let packageVersionId = provisionResponse.packageVersionId;
      if (!packageVersionId) {
        this.log('Hub did not return a package version. Querying Hub for installed version...');
        packageVersionId = await this.queryInstalledPackageVersion(devhubConn);
        if (packageVersionId) {
          this.log(`Found package version: ${packageVersionId}`);
        }
      }

      if (!packageVersionId) {
        throw new Error(
          'No Veles package version found. Ensure the Veles package is installed on the Hub org.',
        );
      }

      this.log('Installing Veles package...');
      this.installPackage(username, packageVersionId, installationKey);
      this.log('Package installed successfully.');
    }

    this.log('Deploying Remote Site Settings...');
    const tmpDir = this.buildRemoteSiteSettingsDir(provisionResponse);
    try {
      this.deployToOrg(username, tmpDir);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    this.log('Configuring Hub URL...');
    this.configureHubUrl(username, provisionResponse.hubUrl);

    this.log('Configuring Public Site Path...');
    this.configureEncryptedPublicSitePath(username, provisionResponse.publicSitePath);

    this.log('Waiting for CMDT deployment...');
    await this.pollCmdtReady(username, 'isConfigReady');

    this.log('Creating self-environment record...');
    this.runApex(username, `${this.apexPrefix('VelesOrgSetup')}.ensureSelfEnvironment();`, 'create self-environment');

    this.log('Marking setup as finished...');
    this.runApex(username, `${this.apexPrefix('VelesOrgSetup')}.markSetupFinished();`, 'mark setup finished');

    this.log('Waiting for setup to finalize...');
    await this.pollCmdtReady(username, 'isSetupFinished');

    this.log('Storing setup token...');
    this.storeSetupToken(username, provisionResponse.environmentToken);

    this.log('Triggering org connect...');
    this.triggerConnect(username, groupName);

    this.log('Waiting for connection to complete...');
    const connected = await this.pollConnectionComplete(username);

    this.log('');
    if (connected) {
      this.log('Org provisioned and connected successfully!');
    } else {
      this.log('Org provisioned but connection timed out.');
      this.log('  The connection may still complete — check the org for errors.');
    }
    this.log(`  Environment: ${provisionResponse.environmentName}`);
    this.log(`  Hub URL: ${provisionResponse.hubUrl}`);
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
      this.log(`Failed to query installed packages on Hub: ${(err as Error).message}`);
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

  private installPackage(username: string, packageVersionId: string, installationKey?: string): void {
    let cmd = `sf package install --package "${packageVersionId}" --target-org "${username}" --wait 15 --no-prompt`;
    if (installationKey) {
      cmd += ` --installation-key "${installationKey}"`;
    }
    try {
      execSync(cmd, { stdio: 'pipe', encoding: 'utf-8' });
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      throw new Error(`Package installation failed: ${error.stdout || error.stderr || error.message}`);
    }
  }

  private async callProvisionEndpoint(
    conn: Connection,
    orgId: string,
    groupName: string | undefined,
    environmentName: string,
    environmentLabel: string,
    orgType?: string,
  ): Promise<ProvisionResponse> {
    const body: Record<string, unknown> = {
      orgId,
      groupName: groupName ?? null,
      environmentName,
      environmentLabel,
    };
    if (orgType) {
      body.orgType = orgType;
    }

    const namespacedPath = `/services/apexrest/${MANAGED_NAMESPACE}/veles/provision`;
    const unnamespacedPath = '/services/apexrest/veles/provision';

    let response: ProvisionResponse | undefined;

    try {
      response = await this.postToEndpoint(conn, namespacedPath, body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; message?: string; errorCode?: string };
      const isNotFound = error.statusCode === 404
        || error.errorCode === 'NOT_FOUND'
        || (error.message ?? '').includes('Could not find a match for URL');
      if (isNotFound) {
        this.namespace = '';
        response = await this.postToEndpoint(conn, unnamespacedPath, body);
      } else if (error.statusCode === 401) {
        throw new Error(
          'VelesDev permission set not assigned. Assign it to your user on the Hub org.',
        );
      } else {
        throw err;
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
    const sitesUrl = hubUrlClean.replace('.my.salesforce.com', '.my.salesforce-sites.com');

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

    fs.writeFileSync(
      path.join(rssDir, 'VelesHubSitesUrl.remoteSite-meta.xml'),
      `<?xml version="1.0" encoding="UTF-8" ?>
<RemoteSiteSetting xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>VelesHubSitesUrl</fullName>
    <isActive>true</isActive>
    <url>${this.escapeXml(sitesUrl)}</url>
    <description>Veles Hub Sites URL</description>
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

  private deployToOrg(username: string, projectDir: string): void {
    const deployCmd = `sf project deploy start --source-dir src --target-org "${username}" --ignore-conflicts`;
    const opts = { cwd: projectDir, stdio: 'pipe' as const, encoding: 'utf-8' as const };

    try {
      execSync(deployCmd, opts);
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      this.log('First deploy attempt failed, retrying...');
      try {
        execSync(deployCmd, opts);
      } catch (retryErr: unknown) {
        const retry = retryErr as { stdout?: string; stderr?: string; message?: string };
        const detail = retry.stdout || retry.stderr || error.message || 'Unknown error';
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
    this.log('  Done.');
  }

  private configureHubUrl(username: string, hubUrl: string): void {
    const escapedUrl = hubUrl.replace(/'/g, "\\'");
    this.runApex(username, `${this.apexPrefix('VelesOrgSetup')}.configureHubUrl('${escapedUrl}');`, 'configure Hub URL');
  }

  private configureEncryptedPublicSitePath(username: string, encryptedSitePath: string): void {
    const escapedPath = encryptedSitePath.replace(/'/g, "\\'");
    this.runApex(username, `${this.apexPrefix('VelesOrgSetup')}.configureEncryptedPublicSitePath('${escapedPath}');`, 'configure Public Site Path');
  }

  private storeSetupToken(username: string, encryptedToken: string): void {
    const escapedToken = encryptedToken.replace(/'/g, "\\'");
    this.runApex(username, `${this.apexPrefix('VelesOrgSetup')}.storeSetupToken('${escapedToken}');`, 'store setup token');
  }

  private triggerConnect(username: string, groupName: string | undefined): void {
    const groupParam = groupName ? `'${groupName}'` : 'null';
    this.runApex(username, `${this.apexPrefix('VelesOrgSetup')}.setupOrg(${groupParam});`, 'trigger connect');
  }

  private runApex(username: string, script: string, operationName: string): void {
    const cmd = `sf apex run --target-org "${username}" --json --file /dev/stdin`;
    try {
      execSync(cmd, { input: script, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' });
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      throw new Error(`Failed to ${operationName}: ${error.stdout || error.stderr || error.message}`);
    }
  }

  private async pollConnectionComplete(username: string): Promise<boolean> {
    const connected = await this.pollApexCondition(
      username,
      `${this.apexPrefix('VelesOrgSetup')}.isConnectionComplete()`,
      'Waiting for connection...',
    );
    if (connected) {
      this.log('  Connection established successfully.');
    }
    return connected;
  }

  private async pollApexCondition(username: string, expression: string, waitMessage: string): Promise<boolean> {
    const marker = 'POLL_CHECK';
    const checkScript = `System.debug('${marker}=' + ${expression});`;

    for (let i = 1; i <= MAX_POLL_ATTEMPTS; i++) {
      try {
        const result = execSync(
          `sf apex run --target-org "${username}" --json --file /dev/stdin`,
          {
            input: checkScript,
            stdio: ['pipe', 'pipe', 'pipe'],
            encoding: 'utf-8',
          },
        );

        if (result.includes(`${marker}=true`)) {
          return true;
        }
      } catch {
      }

      this.log(`  ${waitMessage} (attempt ${i}/${MAX_POLL_ATTEMPTS})`);
      await this.sleep(POLL_INTERVAL_MS);
    }

    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
