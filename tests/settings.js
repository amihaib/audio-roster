import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SCHEMA_ID = 'org.gnome.shell.extensions.audio-roster';

// Safety: the memory backend keeps every write inside this process. Refuse to run
// against the user's real dconf database.
if (GLib.getenv('GSETTINGS_BACKEND') !== 'memory')
    throw new Error('Refusing to run: set GSETTINGS_BACKEND=memory so tests never touch real settings');

const [testsPath] = GLib.filename_from_uri(import.meta.url);
const testsDir = GLib.path_get_dirname(testsPath);
const schemaDir = GLib.build_filenamev([testsDir, '..', 'src', 'schemas']);
const source = Gio.SettingsSchemaSource.new_from_directory(
    schemaDir, Gio.SettingsSchemaSource.get_default(), false);
const schema = source.lookup(SCHEMA_ID, false);
if (!schema)
    throw new Error(`Schema ${SCHEMA_ID} not found in ${schemaDir}; run 'make schemas' first`);

// All Gio.Settings in one process share the memory backend, so reset every key
// to give each test a clean slate.
export function makeSettings() {
    const settings = new Gio.Settings({settings_schema: schema});
    for (const key of schema.list_keys())
        settings.reset(key);
    flush();
    return settings;
}

// GSettings delivers `changed` through the main context; drain it.
export function flush() {
    const context = GLib.MainContext.default();
    while (context.pending())
        context.iteration(false);
}

// Counts writes going through this Gio.Settings instance.
export function countWrites(settings) {
    const counter = {n: 0};
    for (const method of ['set_strv', 'set_value']) {
        const original = settings[method];
        settings[method] = function (...args) {
            counter.n++;
            return original.apply(this, args);
        };
    }
    return counter;
}
