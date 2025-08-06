/*
 * extension.js
 *
 * Main logic for the dmenu-gnome GNOME Shell Extension.
 *
 * Author: Rasmus Steinke
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
    <interface name="org.gnome.Shell.Extensions.DmenuGnome">
        <method name="Show">
            <arg type="as" name="items" direction="in"/>
            <arg type="s" name="prompt" direction="in"/>
        </method>
        <signal name="ItemSelected">
            <arg type="as" name="selected_items"/>
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

    // Signal to the helper script that items were selected
    emitItemSelected(items) {
        this._dbusImpl.emit_signal('ItemSelected', GLib.Variant.new('(as)', [items]));
    }

    // Signal that the user cancelled the operation (e.g., pressed Escape)
    emitCancelled() {
        this._dbusImpl.emit_signal('Cancelled', GLib.Variant.new('()', []));
    }

    export() {
        this._dbusImpl.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/DmenuGnome');
        Gio.DBus.session.own_name('org.gnome.Shell.Extensions.DmenuGnome', Gio.BusNameOwnerFlags.NONE, null, null);
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
        this._selected_items = new Set();
        this._filter_timeout = null;
        this._scroll_start_index = 0;
        this._items_per_page = 20; // Number of DOM elements to render
    }

    show(items, prompt) {
        this._items = items;
        this._selected_items.clear();
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
        
        // Set a longer delay to debounce rapid typing and improve performance
        this._filter_timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
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
                this._updateScrollWindow();
                this._renderVisibleItems();
            }
            return Clutter.EVENT_STOP;
        } else if (symbol === Clutter.KEY_Down || (modifiers & Clutter.ModifierType.CONTROL_MASK && symbol === Clutter.KEY_j)) {
            if (this._visible_items.length > 0) {
                this._selected_index = Math.min(this._visible_items.length - 1, this._selected_index + 1);
                this._updateScrollWindow();
                this._renderVisibleItems();
            }
            return Clutter.EVENT_STOP;
        } else if (symbol === Clutter.KEY_Page_Up) {
            if (this._visible_items.length > 0) {
                const pageSize = this._items_per_page;
                this._selected_index = Math.max(0, this._selected_index - pageSize);
                this._updateScrollWindow();
                this._renderVisibleItems();
            }
            return Clutter.EVENT_STOP;
        } else if (symbol === Clutter.KEY_Page_Down) {
            if (this._visible_items.length > 0) {
                const pageSize = this._items_per_page;
                this._selected_index = Math.min(this._visible_items.length - 1, this._selected_index + pageSize);
                this._updateScrollWindow();
                this._renderVisibleItems();
            }
            return Clutter.EVENT_STOP;
        } else if (symbol === Clutter.KEY_Home || symbol === Clutter.KEY_Begin || 
                   (modifiers & Clutter.ModifierType.CONTROL_MASK && symbol === Clutter.KEY_a)) {
            if (this._visible_items.length > 0) {
                this._selected_index = 0;
                this._updateScrollWindow();
                this._renderVisibleItems();
            }
            return Clutter.EVENT_STOP;
        } else if (symbol === Clutter.KEY_End || 
                   (modifiers & Clutter.ModifierType.CONTROL_MASK && symbol === Clutter.KEY_e)) {
            if (this._visible_items.length > 0) {
                this._selected_index = this._visible_items.length - 1;
                this._updateScrollWindow();
                this._renderVisibleItems();
            }
            return Clutter.EVENT_STOP;
        } else if (symbol === Clutter.KEY_Tab || (modifiers & Clutter.ModifierType.CONTROL_MASK && symbol === Clutter.KEY_space)) {
            // Tab toggles selection and auto-advances, Ctrl+Space toggles without advancing
            if (this._visible_items.length > 0 && this._selected_index < this._visible_items.length) {
                const currentItem = this._visible_items[this._selected_index];
                if (this._selected_items.has(currentItem)) {
                    this._selected_items.delete(currentItem);
                } else {
                    this._selected_items.add(currentItem);
                }
                
                // Auto-advance for Tab, but not for Ctrl+Space
                if (symbol === Clutter.KEY_Tab) {
                    this._selected_index = Math.min(this._visible_items.length - 1, this._selected_index + 1);
                }
                
                this._updateScrollWindow();
                this._renderVisibleItems();
            }
            return Clutter.EVENT_STOP;
        } else if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            if (modifiers & Clutter.ModifierType.SHIFT_MASK) {
                // Shift+Return toggles selection and moves to next item
                if (this._visible_items.length > 0 && this._selected_index < this._visible_items.length) {
                    const currentItem = this._visible_items[this._selected_index];
                    if (this._selected_items.has(currentItem)) {
                        this._selected_items.delete(currentItem);
                    } else {
                        this._selected_items.add(currentItem);
                    }
                    this._selected_index = Math.min(this._visible_items.length - 1, this._selected_index + 1);
                    this._updateScrollWindow();
                    this._renderVisibleItems();
                }
            } else {
                this._onActivate();
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // Handle when user presses Enter
    _onActivate() {
        let itemsToReturn = [];
        
        if (this._selected_items.size > 0) {
            // Return all selected items
            itemsToReturn = Array.from(this._selected_items);
        } else if (this._visible_items.length > 0 && this._selected_index < this._visible_items.length) {
            // If no items selected, return the currently highlighted item
            itemsToReturn = [this._visible_items[this._selected_index]];
        }
        
        if (itemsToReturn.length > 0) {
            this._service.emitItemSelected(itemsToReturn);
            this.hide();
        }
    }

    // Redraw the results list based on the current filter
    _updateResults() {
        const filter = this.entry.get_text().trim().toLowerCase();
        
        // Build full filtered list (no limit)
        this._visible_items = [];
        
        // Tokenize filter into words for multi-word matching
        const filterTokens = filter.split(/\s+/).filter(token => token.length > 0);
        
        for (const item of this._items) {
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

        // Update scroll position to keep selection visible
        this._updateScrollWindow();
        this._renderVisibleItems();
    }
    
    // Update which items should be rendered based on scroll position
    _updateScrollWindow() {
        if (this._visible_items.length === 0) {
            this._scroll_start_index = 0;
            return;
        }
        
        // Keep current selection in view
        const buffer = Math.floor(this._items_per_page / 4); // Buffer for smooth scrolling
        
        if (this._selected_index < this._scroll_start_index + buffer) {
            this._scroll_start_index = Math.max(0, this._selected_index - buffer);
        } else if (this._selected_index >= this._scroll_start_index + this._items_per_page - buffer) {
            this._scroll_start_index = Math.min(
                this._visible_items.length - this._items_per_page,
                this._selected_index - this._items_per_page + buffer + 1
            );
        }
        
        this._scroll_start_index = Math.max(0, this._scroll_start_index);
    }
    
    // Render only the currently visible items
    _renderVisibleItems() {
        this.results_box.remove_all_children();
        
        const end_index = Math.min(
            this._scroll_start_index + this._items_per_page,
            this._visible_items.length
        );
        
        for (let i = this._scroll_start_index; i < end_index; i++) {
            const item = this._visible_items[i];
            const itemContainer = new St.BoxLayout({ style_class: 'dmenu-result-item', vertical: false });
            
            // Add selection indicator
            const indicator = new St.Label({
                text: this._selected_items.has(item) ? '• ' : '  ',
                style_class: 'dmenu-selection-indicator'
            });
            
            const label = new St.Label({ text: item, x_align: Clutter.ActorAlign.FILL });
            
            itemContainer.add_child(indicator);
            itemContainer.add_child(label);
            this.results_box.add_child(itemContainer);
        }
        this._updateSelection();
    }
    
    // Highlight the currently selected item and show multi-selected items
    _updateSelection() {
        const children = this.results_box.get_children();
        
        for (let i = 0; i < children.length; i++) {
            const actualIndex = this._scroll_start_index + i;
            const item = this._visible_items[actualIndex];
            
            // Remove all styling classes first
            children[i].remove_style_class_name('selected');
            children[i].remove_style_class_name('multi-selected');
            
            // Update the selection indicator
            const indicator = children[i].get_first_child();
            indicator.set_text(this._selected_items.has(item) ? '• ' : '  ');
            
            // Apply appropriate styling
            if (this._selected_items.has(item)) {
                children[i].add_style_class_name('multi-selected');
            }
            
            // Highlight if this is the currently selected item
            if (actualIndex === this._selected_index) {
                children[i].add_style_class_name('selected');
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

