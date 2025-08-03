## gnome-extension-dmenu
A dmenu-like Interface for gnome-shell that allows dmenu scripts to work in gnome.

### Why?
Because gnome does not support the layer-shell protocol like any other sensible compositor does. That protocol is needed for rofi and all alternatives to work.

### Usage
1. Install and enable the extension via [https://extensions.gnome.org](https://extensions.gnome.org/extension/8493/dmenu-gnome/) (Still in review)
2. Instead of piping your dmenu scripts to dmenu/rofi, pipe it to the provided dmenu-gnome helper script.

### Example

```
foo=$(ls -1 | $HOME/.local/share/gnome-shell/extensions/dmenu-gnome@carnager.github.io/dmenu-gnome)
echo "${foo}"
```
