# Native media admission before application code

The Linux production WebView starts at the fixed inert `about:blank#21x-native-start` document.
The fixed fragment forces an actual initial WebKit load: the pinned Tauri runtime
skips navigation for the exact string `about:blank`, leaving an uncommitted empty
URI. Empty URIs and all other blank aliases are refused, rather than accepted
as a physical-document receipt.
Native code verifies the original physical main window and open native-work
owner, checks that the blank WebView reports no capture, disables MediaStream
and WebRTC through WebKit settings, and verifies the settings before navigating
to the configured trusted application URL. Development URLs retain the same
trusted localhost policy. Application JavaScript never receives a live capture
API during this startup boundary. Ordinary WebView permission requests remain
denied. No microphone permission request, capture/playback/shortcut owner,
private voice registration or production availability is added.

Native preparation and navigation dispatch remain owned by the existing
native-work driver. Its actual WebView and later idle callbacks are joined,
even when the requester or window goes away. Navigation rechecks the original
physical window, exact blank URL and native admission. A replacement window or
closing owner cannot receive a late application load. Tauri getters/navigation
run after the WebView callback releases its runtime borrow. Failure retains the
inert document with fixed unavailable wording; raw platform/profile diagnostics
are never passed into its UI. The normal physical-document owner starts tracking
the actual trusted application load, rather than accepting a blank-page finish.

This is startup denial, not a general permission grant or stream-revocation
receipt. A cached permission/status or a disabled interface property cannot
stand in for acknowledged closure of an existing stream. Native voice remains
unsupported until exact per-document permission/acquire/bind/publish/retire,
persisted-grant bypass, pending requests and raw stream cleanup are integrated
and proven. Source's optional voice lease/action owners remain unregistered.
Non-Linux native media admission/revocation and installed device proof remain
open; the Linux setting is not represented as macOS or WebView2 acceptance.

The explicitly isolated Wry fixture uses WebKit mock capture devices and a
permissive controlled window as a positive control, with no real microphone.
It observes an actual live mock track and native capture state, refuses to
reinterpret an active/scripted view as startup, stops the mock track through
native capture state, and loads a fresh main document only after the denial
boundary. Its first application script records interface availability. Additional
controls refuse blank URL aliases, keep preparation failure inert with fixed
wording, and close native admission between settings preparation and navigation.
The latter still joins accepted raw callback work and observes no app navigation. The
fixture is not a real-device/provider or supported-platform proof. Exact results,
versions, failure repairs and raw commands belong in revision-bound evidence.

References: [WebKit mock devices](https://webkitgtk.org/reference/webkit2gtk/stable/property.Settings.enable-mock-capture-devices.html),
[native microphone capture state](https://webkitgtk.org/reference/webkit2gtk/stable/method.WebView.set_microphone_capture_state.html),
and [WebKit settings implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/glib/WebKitSettings.cpp).
The capture-state API documents that a page can request capture again; stopping
one stream therefore does not establish a permanent admission fence.

Final app identity/current+legacy schemes and login items remain user decisions.
Hosted Verify unavailable: repository Actions disabled
(actions/permissions enabled:false), awaiting user decision. No settings endpoint,
workflow dispatch, live profile, release or Electron retirement is authorized.
