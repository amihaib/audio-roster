import {Rules} from '../src/lib/rules.js';
import {test, assert, assertEqual, assertDeepEqual} from './assert.js';
import {makeSettings, flush, countWrites} from './settings.js';

const HDMI = 'output|Radeon High Definition Audio Controller|hdmi-output-0';
const LINE_OUT = 'output|Ryzen HD Audio Controller|analog-output-lineout';
const MIC = 'input|C505 HD Webcam|analog-input-mic';

test('defaults are empty', () => {
    const rules = new Rules(makeSettings());
    assertEqual(rules.isHidden(HDMI), false);
    assertEqual(rules.customName(HDMI), null);
    assertDeepEqual(rules.hidden(), []);
    assertEqual(rules.names().size, 0);
    assertEqual(rules.known().size, 0);
    assertEqual(rules.present().size, 0);
});

test('setHidden adds and removes a key, writing only on change', () => {
    const settings = makeSettings();
    const writes = countWrites(settings);
    const rules = new Rules(settings);

    rules.setHidden(HDMI, true);
    assertEqual(rules.isHidden(HDMI), true);
    assertDeepEqual(rules.hidden(), [HDMI]);
    assertEqual(writes.n, 1);

    rules.setHidden(HDMI, true);
    assertEqual(writes.n, 1, 'no write when already hidden');

    rules.setHidden(LINE_OUT, true);
    assertDeepEqual(rules.hidden(), [HDMI, LINE_OUT]);

    rules.setHidden(HDMI, false);
    assertDeepEqual(rules.hidden(), [LINE_OUT]);
    assertEqual(writes.n, 3);

    rules.setHidden(HDMI, false);
    assertEqual(writes.n, 3, 'no write when already visible');
});

test('setName stores trimmed names; blank or null removes', () => {
    const settings = makeSettings();
    const writes = countWrites(settings);
    const rules = new Rules(settings);

    rules.setName(LINE_OUT, '  Speakers ');
    assertEqual(rules.customName(LINE_OUT), 'Speakers');
    assertDeepEqual([...rules.names()], [[LINE_OUT, 'Speakers']]);
    assertEqual(writes.n, 1);

    rules.setName(LINE_OUT, 'Speakers');
    assertEqual(writes.n, 1, 'no write for the same name');

    rules.setName(LINE_OUT, '   ');
    assertEqual(rules.customName(LINE_OUT), null);
    assertEqual(rules.names().size, 0);
    assertEqual(writes.n, 2);

    rules.setName(LINE_OUT, null);
    assertEqual(writes.n, 2, 'no write when already unset');
});

test('markSeen records the original label and writes only for new keys or changed labels', () => {
    const settings = makeSettings();
    const writes = countWrites(settings);
    const rules = new Rules(settings);

    rules.markSeen(HDMI, 'HDMI / DisplayPort – Radeon High Definition Audio Controller');
    rules.markSeen(MIC, 'Microphone – C505 HD Webcam');
    assertEqual(writes.n, 2);
    assertEqual(rules.known().get(MIC), 'Microphone – C505 HD Webcam');

    rules.markSeen(HDMI, 'HDMI / DisplayPort – Radeon High Definition Audio Controller');
    assertEqual(writes.n, 2, 'same label is not rewritten');

    rules.markSeen(HDMI, 'HDMI / DisplayPort 2 – Radeon High Definition Audio Controller');
    assertEqual(writes.n, 3);
    assertEqual(rules.known().get(HDMI), 'HDMI / DisplayPort 2 – Radeon High Definition Audio Controller');
});

test('setPresent sorts, de-duplicates and skips identical sets', () => {
    const settings = makeSettings();
    const writes = countWrites(settings);
    const rules = new Rules(settings);

    rules.setPresent([LINE_OUT, HDMI, LINE_OUT]);
    assertDeepEqual(settings.get_strv('present-devices'), [HDMI, LINE_OUT]);
    assertDeepEqual([...rules.present()].sort(), [HDMI, LINE_OUT]);
    assertEqual(writes.n, 1);

    rules.setPresent([HDMI, LINE_OUT]);
    rules.setPresent(new Set([LINE_OUT, HDMI]));
    assertEqual(writes.n, 1, 'same set in any order is not rewritten');

    rules.setPresent([]);
    assertEqual(rules.present().size, 0);
    assertEqual(writes.n, 2);
});

test('forget removes a key from hidden, names and known', () => {
    const rules = new Rules(makeSettings());
    rules.setHidden(HDMI, true);
    rules.setName(HDMI, 'Monitor');
    rules.markSeen(HDMI, 'HDMI / DisplayPort – Radeon High Definition Audio Controller');
    rules.markSeen(MIC, 'Microphone – C505 HD Webcam');

    rules.forget(HDMI);
    assertEqual(rules.isHidden(HDMI), false);
    assertEqual(rules.customName(HDMI), null);
    assertDeepEqual([...rules.known().keys()], [MIC]);
});

test('onRulesChanged fires for hidden-devices and device-names only', () => {
    const rules = new Rules(makeSettings());
    let rulesCalls = 0;
    let registryCalls = 0;
    const rulesHandle = rules.onRulesChanged(() => rulesCalls++);
    const registryHandle = rules.onRegistryChanged(() => registryCalls++);

    rules.setHidden(HDMI, true);
    flush();
    assertEqual(rulesCalls, 1);
    assertEqual(registryCalls, 0);

    rules.setName(LINE_OUT, 'Speakers');
    flush();
    assertEqual(rulesCalls, 2);

    rules.markSeen(MIC, 'Microphone – C505 HD Webcam');
    rules.setPresent([MIC]);
    flush();
    assertEqual(rulesCalls, 2, 'registry writes must not trigger rule callbacks');
    assertEqual(registryCalls, 2);

    rules.disconnect(rulesHandle);
    rules.disconnect(registryHandle);
    rules.setHidden(LINE_OUT, true);
    rules.setPresent([]);
    flush();
    assertEqual(rulesCalls, 2, 'disconnected handlers stay silent');
    assertEqual(registryCalls, 2, 'disconnected handlers stay silent');
    assert(rulesHandle.length === 0, 'disconnect empties the handle');
});
