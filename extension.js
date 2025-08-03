/*
 * extension.js
 *
 * Main logic for the dmenu-gnome GNOME Shell Extension.
 *
 * Author: Gemini
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

// --- DBus Service Setup ---
// This is the interface that the helper script will talk to.
const DBUS_INTERFACE = `
<node>
    <interface name="com.gemini.dmenu">
        <method name="Show">
            <arg type="as" name="items" direction="in"/>
            <arg type="s" name="prompt" direction="in"/>
        </method>
        <signal name="ItemSelected">
            <arg type="s" name="selected_item"/>
        </signal>
        <signal name="Cancelled"/>
    </interface>
</node>`;

class DmenuService {
    constructor(extension) {
        this._extension = extension;
        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(DBUS_INTERFACE, this);
    }

    // Method called by the helper script to show the dmenu UI
    Show(items, prompt) {
        this._extension.show(items, prompt);
    }

    // Signal to the helper script that an item was selected
    emitItemSelected(item) {
        this._dbusImpl.emit_signal('ItemSelected', GLib.Variant.new('(s)', [item]));
    }

    // Signal that the user cancelled the operation (e.g., pressed Escape)
    emitCancelled() {
        this._dbusImpl.emit_signal('Cancelled', GLib.Variant.new('()', []));
    }

    export() {
        this._dbusImpl.export(Gio.DBus.session, '/com/gemini/dmenu');
        Gio.DBus.session.own_name('com.gemini.dmenu', Gio.BusNameOwnerFlags.NONE, null, null);
    }

    unexport() {
        this._dbusImpl.unexport();
    }
}


class DmenuUI {
    constructor(service) {
        this._service = service;
        this.actor = new St.BoxLayout({
            style_class: 'dmenu-container',
            vertical: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.START,
            reactive: true,
        });

        // This container holds the prompt and the text entry
        this.top_bar = new St.BoxLayout({
            style_class: 'dmenu-top-bar',
            vertical: false,
        });

        this.prompt_label = new St.Label({
            style_class: 'dmenu-prompt',
            y_align: Clutter.ActorAlign.CENTER,
        });
        
        this.entry = new St.Entry({
            style_class: 'dmenu-entry',
            can_focus: true,
            x_expand: true,
        });

        // This container holds the list of results
        this.results_container = new St.ScrollView({
            style_class: 'dmenu-results-container',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        this.results_box = new St.BoxLayout({ style_class: 'dmenu-results-box', vertical: true });
        
        // FIX: Use set_child for St.ScrollView instead of add_actor
        this.results_container.set_child(this.results_box);
        
        // Assemble the UI
        this.top_bar.add_child(this.prompt_label);
        this.top_bar.add_child(this.entry);
        this.actor.add_child(this.top_bar);
        this.actor.add_child(this.results_container);

        // --- Event Handling ---
        this.entry.get_clutter_text().connect('text-changed', this._onTextChanged.bind(this));
        this.entry.get_clutter_text().connect('activate', this._onActivate.bind(this));
        this.actor.connect('key-press-event', this._onKeyPress.bind(this));

        this._items = [];
        this._visible_items = [];
        this._selected_index = 0;
        this._filter_timeout = null;
    }

    show(items, prompt) {
        this._items = items;
        this.prompt_label.set_text(prompt + " ");
        this.entry.set_text('');
        this._selected_index = 0;
        
        // Position the actor to fill the entire screen
        const monitor = Main.layoutManager.primaryMonitor;
        this.actor.set_position(monitor.x, monitor.y);
        this.actor.set_size(monitor.width, monitor.height);
        
        Main.uiGroup.add_child(this.actor);
        
        // Grab global key focus to ensure we capture all key events
        global.stage.set_key_focus(this.entry);
        this.entry.grab_key_focus();
        
        this._updateResults();
    }

    hide() {
        // Clean up any pending filter timeout
        if (this._filter_timeout) {
            GLib.source_remove(this._filter_timeout);
            this._filter_timeout = null;
        }
        Main.uiGroup.remove_child(this.actor);
    }

    // Filter results when user types (with debouncing for performance)
    _onTextChanged() {
        // Clear any existing timeout
        if (this._filter_timeout) {
            GLib.source_remove(this._filter_timeout);
        }
        
        // Set a short delay to debounce rapid typing
        this._filter_timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._selected_index = 0;
            this._updateResults();
            this._filter_timeout = null;
            return GLib.SOURCE_REMOVE;
        });
    }
    
    // Handle key presses for navigation and selection
    _onKeyPress(actor, event) {
        const symbol = event.get_key_symbol();
        const modifiers = event.get_state();
        
        if (symbol === Clutter.KEY_Escape) {
            this._service.emitCancelled();
            this.hide();
            return Clutter.EVENT_STOP;
        } else if (symbol === Clutter.KEY_Up || (modifiers & Clutter.ModifierType.CONTROL_MASK && symbol === Clutter.KEY_k)) {
            if (this._visible_items.length > 0) {
                this._selected_index = Math.max(0, this._selected_index - 1);
                this._updateSelection();
            }
            return Clutter.EVENT_STOP;
        } else if (symbol === Clutter.KEY_Down || (modifiers & Clutter.ModifierType.CONTROL_MASK && symbol === Clutter.KEY_j)) {
            if (this._visible_items.length > 0) {
                this._selected_index = Math.min(this._visible_items.length - 1, this._selected_index + 1);
                this._updateSelection();
            }
            return Clutter.EVENT_STOP;
        } else if (symbol === Clutter.KEY_Tab) {
            // Tab cycles through items
            if (this._visible_items.length > 0) {
                this._selected_index = (this._selected_index + 1) % this._visible_items.length;
                this._updateSelection();
            }
            return Clutter.EVENT_STOP;
        } else if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            this._onActivate();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // Handle when user presses Enter
    _onActivate() {
        if (this._visible_items.length > 0 && this._selected_index < this._visible_items.length) {
            const selectedItem = this._visible_items[this._selected_index];
            this._service.emitItemSelected(selectedItem);
            this.hide();
        }
    }

    // Redraw the results list based on the current filter
    _updateResults() {
        this.results_box.remove_all_children();
        const filter = this.entry.get_text().trim().toLowerCase();
        
        // Optimize filtering and limit results for performance
        this._visible_items = [];
        const MAX_RESULTS = 50; // Limit visible results for performance
        
        // Tokenize filter into words for multi-word matching
        const filterTokens = filter.split(/\s+/).filter(token => token.length > 0);
        
        for (const item of this._items) {
            if (this._visible_items.length >= MAX_RESULTS) break;
            
            const itemLower = item.toLowerCase();
            
            // If no filter, show all items
            if (filterTokens.length === 0) {
                this._visible_items.push(item);
                continue;
            }
            
            // Check if all filter tokens are present in the item
            const allTokensMatch = filterTokens.every(token => itemLower.includes(token));
            
            if (allTokensMatch) {
                this._visible_items.push(item);
            }
        }

        // Create UI elements only for visible items
        for (const item of this._visible_items) {
            const label = new St.Label({ text: item, style_class: 'dmenu-result-item', x_align: Clutter.ActorAlign.FILL });
            this.results_box.add_child(label);
        }
        this._updateSelection();
    }
    
    // Highlight the currently selected item
    _updateSelection() {
        const children = this.results_box.get_children();
        for (let i = 0; i < children.length; i++) {
            if (i === this._selected_index) {
                children[i].add_style_class_name('selected');
                // Ensure the selected item is visible in the scroll view
                const itemY = children[i].get_allocation_box().y1;
                const itemHeight = children[i].get_height();
                const scrollViewHeight = this.results_container.get_height();
                const scrollAdjustment = this.results_container.get_vadjustment();
                const currentScrollValue = scrollAdjustment.get_value();

                if (itemY < currentScrollValue) {
                    scrollAdjustment.set_value(itemY);
                } else if (itemY + itemHeight > currentScrollValue + scrollViewHeight) {
                    scrollAdjustment.set_value(itemY + itemHeight - scrollViewHeight);
                }

            } else {
                children[i].remove_style_class_name('selected');
            }
        }
    }
}


export default class DmenuExtension extends Extension {
    enable() {
        this._service = new DmenuService(this);
        this._service.export();
        this._ui = new DmenuUI(this._service);
    }

    disable() {
        this._service.unexport();
        this._service = null;
        this._ui.hide();
        this._ui = null;
    }

    show(items, prompt) {
        this._ui.show(items, prompt || '>');
    }
}
