import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

class TrackerSettings {
    constructor() {
        this._defaults = {
            indicatorPosition: 'left',
            childLimit: 5,
            topAppCount: 8,
            autoStartServer: true,
        };
        this._configDir = GLib.build_filenamev([GLib.get_user_config_dir(), 'app-usage-tracker']);
        this._settingsPath = GLib.build_filenamev([this._configDir, 'settings.json']);
    }

    _read() {
        try {
            if (!GLib.file_test(this._settingsPath, GLib.FileTest.EXISTS))
                return {...this._defaults};

            const [ok, contents] = GLib.file_get_contents(this._settingsPath);
            if (!ok)
                return {...this._defaults};

            const text = typeof contents === 'string' ? contents : new TextDecoder().decode(contents);
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== 'object')
                return {...this._defaults};
            return {...this._defaults, ...parsed};
        } catch (e) {
            return {...this._defaults};
        }
    }

    _write(data) {
        try {
            GLib.mkdir_with_parents(this._configDir, 0o755);
            GLib.file_set_contents(this._settingsPath, JSON.stringify(data));
        } catch (e) {
            log('[AppUsageTrackerPrefs] Failed to write settings: ' + e);
        }
    }

    getAll() {
        const data = this._read();
        if (data.indicatorPosition !== 'left' && data.indicatorPosition !== 'center' && data.indicatorPosition !== 'right')
            data.indicatorPosition = this._defaults.indicatorPosition;
        const childLimit = Number(data.childLimit);
        data.childLimit = Number.isFinite(childLimit) ? Math.max(1, Math.min(20, Math.floor(childLimit))) : this._defaults.childLimit;
        const topAppCount = Number(data.topAppCount);
        data.topAppCount = Number.isFinite(topAppCount) ? Math.max(1, Math.min(30, Math.floor(topAppCount))) : this._defaults.topAppCount;
        data.autoStartServer = Boolean(data.autoStartServer);
        return data;
    }

    update(patch) {
        const current = this.getAll();
        this._write({...current, ...patch});
    }
}

export default class AppUsageTrackerPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = new TrackerSettings();
        const current = settings.getAll();

        window.set_title('App Usage Tracker Preferences');
        window.set_default_size(560, 380);

        const page = new Adw.PreferencesPage({
            title: 'General',
        });

        const behaviorGroup = new Adw.PreferencesGroup({
            title: 'Behavior',
            description: 'These settings are applied when the extension is re-enabled.',
        });

        const positionRow = new Adw.ComboRow({
            title: 'Panel Position',
            subtitle: 'Choose where the indicator appears in the top bar.',
            model: Gtk.StringList.new(['Left', 'Center', 'Right']),
        });

        const positionToIndex = {left: 0, center: 1, right: 2};
        const indexToPosition = ['left', 'center', 'right'];
        positionRow.set_selected(positionToIndex[current.indicatorPosition] ?? 0);
        positionRow.connect('notify::selected', row => {
            const selected = indexToPosition[row.get_selected()] || 'left';
            settings.update({indicatorPosition: selected});
        });
        behaviorGroup.add(positionRow);

        const childLimitRow = new Adw.ActionRow({
            title: 'Website Children Per App',
            subtitle: 'Maximum number of website children shown for each app.',
        });

        const adjustment = new Gtk.Adjustment({
            lower: 1,
            upper: 20,
            step_increment: 1,
            page_increment: 1,
            value: current.childLimit,
        });

        const childLimitSpin = new Gtk.SpinButton({
            adjustment,
            climb_rate: 1,
            digits: 0,
            valign: Gtk.Align.CENTER,
        });
        childLimitSpin.connect('value-changed', spin => {
            settings.update({childLimit: spin.get_value_as_int()});
        });

        childLimitRow.add_suffix(childLimitSpin);
        childLimitRow.set_activatable_widget(childLimitSpin);
        behaviorGroup.add(childLimitRow);

        const topAppCountRow = new Adw.ActionRow({
            title: 'Top Apps In Menu',
            subtitle: 'How many top apps are shown in the GNOME extension list.',
        });

        const topAppAdjustment = new Gtk.Adjustment({
            lower: 1,
            upper: 30,
            step_increment: 1,
            page_increment: 1,
            value: current.topAppCount,
        });

        const topAppSpin = new Gtk.SpinButton({
            adjustment: topAppAdjustment,
            climb_rate: 1,
            digits: 0,
            valign: Gtk.Align.CENTER,
        });
        topAppSpin.connect('value-changed', spin => {
            settings.update({topAppCount: spin.get_value_as_int()});
        });

        topAppCountRow.add_suffix(topAppSpin);
        topAppCountRow.set_activatable_widget(topAppSpin);
        behaviorGroup.add(topAppCountRow);

        const autoStartRow = new Adw.ActionRow({
            title: 'Auto-start Local Server',
            subtitle: 'Start server automatically when extension enables and when Open Dashboard is clicked.',
        });

        const autoStartSwitch = new Gtk.Switch({
            active: current.autoStartServer,
            valign: Gtk.Align.CENTER,
        });
        autoStartSwitch.connect('notify::active', sw => {
            settings.update({autoStartServer: sw.active});
        });

        autoStartRow.add_suffix(autoStartSwitch);
        autoStartRow.set_activatable_widget(autoStartSwitch);
        behaviorGroup.add(autoStartRow);

        const infoGroup = new Adw.PreferencesGroup({
            title: 'Info',
        });

        infoGroup.add(new Adw.ActionRow({
            title: 'Unified Tracking Model',
            subtitle: 'Usage is stored as app -> total time + children websites.',
        }));

        page.add(behaviorGroup);
        page.add(infoGroup);
        window.add(page);
    }
}
