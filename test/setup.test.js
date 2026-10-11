import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import VelesSetup, { GROUP_ON_SANDBOX_REFUSAL, VELES_DEV_NOT_ASSIGNED, hubRefusalOf } from '../lib/commands/veles/setup.js';
import httpApiModule from '@jsforce/jsforce-node/lib/http-api.js';

test('buildRemoteSiteSettingsDir emits only the Hub My Domain remote site', () => {
    const command = Object.create(VelesSetup.prototype);
    const tmpDir = command.buildRemoteSiteSettingsDir({ hubUrl: 'https://veles-hub.my.salesforce.com/' });

    try {
        const rssDir = path.join(tmpDir, 'src', 'remoteSiteSettings');
        assert.deepEqual(fs.readdirSync(rssDir), ['VelesHubUrl.remoteSite-meta.xml']);

        const xml = fs.readFileSync(path.join(rssDir, 'VelesHubUrl.remoteSite-meta.xml'), 'utf8');
        assert.match(xml, /<url>https:\/\/veles-hub\.my\.salesforce\.com<\/url>/);
        assert.doesNotMatch(xml, /salesforce-sites/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildSeatGrantScript calls the VelesOrgSetup seat facade for the integration user on a namespaced install', () => {
    const command = Object.create(VelesSetup.prototype);
    const script = command.buildSeatGrantScript("o'veles.integration@example.com", 'btcveles');

    assert.match(script, /btcveles\.VelesOrgSetup\.assignVelesSeat\('o\\'veles\.integration@example\.com'\)/);
    assert.match(script, /System\.debug\('SEAT_GRANT_RESULT:'/);
    assert.doesNotMatch(script, /"/);
});

test('buildSeatGrantScript emits no seat call for a source-deployed target', () => {
    const command = Object.create(VelesSetup.prototype);

    assert.equal(command.buildSeatGrantScript('veles.integration@example.com', ''), null);
});

test('parseSeatGrantOutcome returns the facade text after the marker and null when blank or absent', () => {
    const command = Object.create(VelesSetup.prototype);
    const remediation = 'No free Veles seat on this org (2 of 2 assigned). Free one under Setup > Installed Packages > Manage Licenses.';
    const log = ['10:00:00.1 (1)|EXECUTION_STARTED', `10:00:00.2 (2)|USER_DEBUG|[2]|DEBUG|SEAT_GRANT_RESULT:${remediation}`, '10:00:00.3 (3)|EXECUTION_FINISHED'].join('\n');

    assert.equal(command.parseSeatGrantOutcome(log), remediation);
    assert.equal(command.parseSeatGrantOutcome('10:00:00.2 (2)|USER_DEBUG|[2]|DEBUG|SEAT_GRANT_RESULT:'), null);
    assert.equal(command.parseSeatGrantOutcome('10:00:00.1 (1)|EXECUTION_STARTED'), null);
});

test('buildTriggerConnectScript passes every --group through as an ordered Apex List<String>', () => {
    const command = Object.create(VelesSetup.prototype);
    command.namespace = 'btcveles';

    assert.equal(command.buildTriggerConnectScript(['Overlay', 'Baseline']), "btcveles.VelesOrgSetup.setupOrg(new List<String>{ 'Overlay', 'Baseline' });");
});

test('buildTriggerConnectScript emits an empty list when no --group was given', () => {
    const command = Object.create(VelesSetup.prototype);
    command.namespace = '';

    assert.equal(command.buildTriggerConnectScript([]), 'VelesOrgSetup.setupOrg(new List<String>{  });');
});

test('buildTriggerConnectScript escapes a single quote in a group name', () => {
    const command = Object.create(VelesSetup.prototype);
    command.namespace = '';

    assert.equal(command.buildTriggerConnectScript(["O'Brien Group"]), "VelesOrgSetup.setupOrg(new List<String>{ 'O\\'Brien Group' });");
});

test('buildTriggerConnectScript escapes a backslash before the quote it protects', () => {
    const command = Object.create(VelesSetup.prototype);
    command.namespace = '';

    assert.equal(command.buildTriggerConnectScript(['Ends With Backslash\\']), "VelesOrgSetup.setupOrg(new List<String>{ 'Ends With Backslash\\\\' });");
    assert.equal(command.buildTriggerConnectScript(["Already\\'Escaped"]), "VelesOrgSetup.setupOrg(new List<String>{ 'Already\\\\\\'Escaped' });");
});

test('buildProvisionBody sends groupNames as an ordered array, empty when no --group was given', () => {
    const command = Object.create(VelesSetup.prototype);

    assert.deepEqual(command.buildProvisionBody('00D000000000001', ['Overlay', 'Baseline'], 'env', 'Env', undefined, 'svc@example.com').groupNames, ['Overlay', 'Baseline']);
    assert.deepEqual(command.buildProvisionBody('00D000000000001', [], 'env', 'Env', undefined, 'svc@example.com').groupNames, []);
});

test('buildProvisionBody no longer sends the retired single groupName key', () => {
    const command = Object.create(VelesSetup.prototype);
    const body = command.buildProvisionBody('00D000000000001', ['Overlay'], 'env', 'Env', undefined, 'svc@example.com');

    assert.equal('groupName' in body, false);
});

test('GROUP_ON_SANDBOX_REFUSAL is the exact message the Hub mirrors', () => {
    assert.equal(GROUP_ON_SANDBOX_REFUSAL, '--group applies to scratch orgs only; sandbox memberships come from the Hub environment');
});

test('run refuses --group on a sandbox before it ever reaches the Hub', async () => {
    const command = Object.create(VelesSetup.prototype);
    let hubWasCalled = false;

    command.parse = async () => ({
        flags: { 'target-org': fakeOrg(), group: ['Overlay'], 'integration-permset': 'VelesIntegration' }
    });
    command.jsonEnabled = () => true;
    command.queryOrgInfo = async () => ({ Id: '00D000000000001', Name: 'Sbx', IsSandbox: true, TrialExpirationDate: null });
    command.resolveDevHub = async () => {
        hubWasCalled = true;
        return fakeOrg();
    };
    command.callProvisionEndpoint = async () => {
        hubWasCalled = true;
        return {};
    };

    await assert.rejects(
        () => VelesSetup.prototype.run.call(command),
        err => err.message === GROUP_ON_SANDBOX_REFUSAL
    );
    assert.equal(hubWasCalled, false, 'the refusal must precede every Hub round-trip');
});

const HUB_URL = 'https://veles-hub.my.salesforce.com';
const AT_CAP =
    'Your Free plan includes 2 connected orgs and all of them are in use. Orgs you already connected keep working; only new ones are blocked. On that Hub, delete an environment you no longer use in Veles Command Center > Environment Management, or contact us to upgrade your plan.';
const REMEDY = 'delete an environment you no longer use';

async function jsforceErrorFor(statusCode, body, contentType = 'application/json') {
    const api = Object.create(httpApiModule.HttpApi.prototype);
    api._logger = { debug: () => undefined };
    return api.getError({ statusCode, headers: { 'content-type': contentType }, body });
}

function hubRefusalBody(error, errorCode) {
    return JSON.stringify({ success: false, error, errorCode });
}

function provisionCommandRejecting(...errors) {
    const command = Object.create(VelesSetup.prototype);
    const calledPaths = [];
    command.namespace = 'btcveles';
    command.postToEndpoint = async (conn, urlPath) => {
        calledPaths.push(urlPath);
        throw errors.shift();
    };
    return { command, calledPaths };
}

function callProvision(command) {
    return command.callProvisionEndpoint({ instanceUrl: HUB_URL }, '00D000000000001', [], 'env', 'Env', undefined, 'svc@example.com');
}

test('hubRefusalOf unwraps the body of a real jsforce 403 error', async () => {
    const err = await jsforceErrorFor(403, hubRefusalBody(AT_CAP, 'CONNECTED_ORG_LIMIT'));

    assert.equal(err.errorCode, 'ERROR_HTTP_403', 'jsforce keeps the raw body as the message when it carries no message key');
    assert.equal(hubRefusalOf(err), AT_CAP);
});

test('callProvisionEndpoint rethrows the Hub refusal with the Hub URL on the namespaced call', async () => {
    const { command, calledPaths } = provisionCommandRejecting(await jsforceErrorFor(403, hubRefusalBody(AT_CAP, 'CONNECTED_ORG_LIMIT')));

    await assert.rejects(
        () => callProvision(command),
        err => {
            assert.equal(err.message.split(REMEDY).length - 1, 1, 'the Hub text already carries the remedy, so the CLI must not repeat it');
            assert.equal(err.message, `The Hub ${HUB_URL} refused to connect this org: ${AT_CAP}`);
            return true;
        }
    );
    assert.equal(calledPaths.length, 1, 'a refusal is final; only a 404 falls back to the no-namespace path');
});

test('callProvisionEndpoint rethrows the Hub refusal on the no-namespace fallback call', async () => {
    const notFound = await jsforceErrorFor(404, JSON.stringify([{ errorCode: 'NOT_FOUND', message: 'Could not find a match for URL' }]));
    const refusal = await jsforceErrorFor(403, hubRefusalBody(AT_CAP, 'CONNECTED_ORG_LIMIT'));
    const { command, calledPaths } = provisionCommandRejecting(notFound, refusal);

    await assert.rejects(
        () => callProvision(command),
        err => {
            assert.equal(err.message.split(REMEDY).length - 1, 1, 'the Hub text already carries the remedy, so the CLI must not repeat it');
            assert.equal(err.message, `The Hub ${HUB_URL} refused to connect this org: ${AT_CAP}`);
            return true;
        }
    );
    assert.deepEqual(calledPaths, ['/services/apexrest/btcveles/veles/provision', '/services/apexrest/veles/provision']);
    assert.equal(command.namespace, '');
});

test('callProvisionEndpoint names the Hub for any other refusal', async () => {
    const refusal = await jsforceErrorFor(400, hubRefusalBody('Scratch org not found or not active on this DevHub'));
    const { command } = provisionCommandRejecting(refusal);

    await assert.rejects(
        () => callProvision(command),
        err => err.message === `The Hub ${HUB_URL} refused to connect this org: Scratch org not found or not active on this DevHub`
    );
});

test('callProvisionEndpoint maps a 401 on the fallback to the VelesDev message', async () => {
    const notFound = await jsforceErrorFor(404, JSON.stringify([{ errorCode: 'NOT_FOUND', message: 'Could not find a match for URL' }]));
    const unauthorized = await jsforceErrorFor(401, hubRefusalBody('VelesDev permission set required'));
    const { command } = provisionCommandRejecting(notFound, unauthorized);

    await assert.rejects(
        () => callProvision(command),
        err => err.message === VELES_DEV_NOT_ASSIGNED
    );
});

test('callProvisionEndpoint does not report an expired session as a missing VelesDev permission set', async () => {
    const expired = await jsforceErrorFor(401, JSON.stringify([{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired or invalid' }]));
    const { command } = provisionCommandRejecting(expired);

    await assert.rejects(
        () => callProvision(command),
        err => {
            assert.notEqual(err.message, VELES_DEV_NOT_ASSIGNED, 'a Salesforce 401 carries its own errorCode, so only the Hub endpoint body may map to the VelesDev hint');
            assert.equal(err, expired);
            return true;
        }
    );
});

test('callProvisionEndpoint rethrows a non-JSON error unchanged', async () => {
    const original = new Error('socket hang up');
    const { command } = provisionCommandRejecting(original);

    await assert.rejects(
        () => callProvision(command),
        err => err === original
    );
});

function fakeOrg() {
    return {
        refreshAuth: async () => undefined,
        getConnection: () => ({}),
        getUsername: () => 'user@example.com'
    };
}
