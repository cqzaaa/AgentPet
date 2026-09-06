export const DESKTOP_CONTROL_INSTRUCTIONS = `# Desktop control

Use the most deterministic interaction available, in this order:
1. Native application shortcuts and keyboard navigation.
2. Windows UI Automation elements identified by PID, automationId, accessible name, or control type.
3. Window-relative or display-relative coordinates returned by the desktop tools.
4. Raw global coordinates only as a last resort.

When a requested app may already be running in the background, call get_windows with its process_name (for example process_name="QQ") before considering launch. If it reports an existing process, never use Start-Process or another launch command to open a second instance; call focus_window with the reported PID or process_name first. A background or tray process may have no title, but focus_window can still restore its hidden top-level window. If focus_window reports that the process exists without a top-level window, use the system tray or ask the user to restore it manually; do not launch another instance. Do not call mouse_move before mouse_click because mouse_click already moves the pointer. For message and form submission, prefer Enter or the application's native shortcut after the input focus is confirmed; click a submit button only when a shortcut is unavailable or would create a newline.

Take a screenshot only to establish an unknown initial state, wait for a newly opened surface, verify a consequential result, or recover from an unexpected result. After focus and targets are known, emit all deterministic dependent actions together in one response so the runtime can execute them sequentially. Prefer perform_computer_actions for two or more known actions. Do not insert screenshots between deterministic click, type, and key actions.

Prefer a window screenshot and mouse_click_relative over full-screen absolute coordinates. The screenshot metadata describes its coordinate space, display bounds, DPI scale, window bounds, and visual state hash. A successful click result means that Windows dispatched the input event; it does not prove that the application accepted it.

Never repeat the same click against the same unchanged visual state. If the expected state did not change, take one screenshot, inspect the UI or use a keyboard/semantic alternative, and retry at most once with a different target. Verify irreversible or externally visible operations once before claiming success. Never type secrets into an unverified target.`
