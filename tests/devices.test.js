import {deviceKey, deviceLabel, deviceType, keyType, INPUT, OUTPUT} from '../src/lib/devices.js';
import {test, assertEqual} from './assert.js';
import {FakeDevice} from './fakes.js';

const lineOut = () => new FakeDevice({
    id: 8, description: 'Line Out', origin: 'Ryzen HD Audio Controller',
    port: 'analog-output-lineout', output: true,
});

test('deviceLabel joins description and origin with an en dash', () => {
    assertEqual(deviceLabel(lineOut()), 'Line Out – Ryzen HD Audio Controller');
});

test('deviceLabel without origin is the description alone', () => {
    const d = new FakeDevice({id: 1, description: 'Dummy Output', origin: null});
    assertEqual(deviceLabel(d), 'Dummy Output');
    const e = new FakeDevice({id: 2, description: 'Dummy Output', origin: ''});
    assertEqual(deviceLabel(e), 'Dummy Output');
});

test('deviceType follows is_output()', () => {
    assertEqual(deviceType(lineOut()), OUTPUT);
    assertEqual(deviceType(new FakeDevice({id: 3, description: 'Mic', output: false})), INPUT);
});

test('deviceKey uses type, origin and port name', () => {
    assertEqual(deviceKey(lineOut()), 'output|Ryzen HD Audio Controller|analog-output-lineout');
});

test('deviceKey ignores the stream name when a port exists', () => {
    assertEqual(deviceKey(lineOut(), 'alsa_output.pci-0000_14_00.6.analog-stereo'),
        'output|Ryzen HD Audio Controller|analog-output-lineout');
});

test('deviceKey falls back to the stream name when there is no port', () => {
    const d = new FakeDevice({id: 4, description: 'Speakers', origin: null, port: null});
    assertEqual(deviceKey(d, 'alsa_output.usb-foo'), 'output||stream:alsa_output.usb-foo');
});

test('deviceKey falls back to the description when there is neither port nor stream', () => {
    const d = new FakeDevice({id: 5, description: 'Microphone', origin: 'Some Card', port: '', output: false});
    assertEqual(deviceKey(d), 'input|Some Card|desc:Microphone');
});

test('keyType reads the type prefix, defaulting to output', () => {
    assertEqual(keyType('input|Card|port'), INPUT);
    assertEqual(keyType('output|Card|port'), OUTPUT);
    assertEqual(keyType('garbage'), OUTPUT);
});
