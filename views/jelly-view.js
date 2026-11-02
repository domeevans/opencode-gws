// jelly-view.js: a client of Jelly's view bridge. Paste it into the page's own <script>:
// a sealed page loads no script by URL and is given no global. Call jellyView() as the
// script starts; it resolves with the client when the app says hello.
function jellyView() {
  return new Promise((resolve) => {
    addEventListener("message", function hello(event) {
      const said = event.data;
      if (event.source !== parent || said?.v !== 1 || said.kind !== "hello" || !event.ports[0])
        return;
      removeEventListener("message", hello);
      const port = event.ports[0];
      const listeners = new Set();
      const latest = new Map();
      const queue = [];
      let sequence = 0;
      let current;
      const theme = (tokens) => {
        const style = document.documentElement.style;
        for (const [name, value] of Object.entries(tokens))
          if (name === "scheme") style.colorScheme = value;
          else style.setProperty(`--jelly-${name}`, value);
      };
      // The app answers one request at a time, so requests go in turn.
      const next = () => {
        if (current !== undefined || queue.length === 0) return;
        current = queue.shift();
        current.timer = setTimeout(
          () => settle({ ok: false, error: "No answer from the app" }),
          15000,
        );
        port.postMessage(current.message);
      };
      const settle = (answer) => {
        const done = current;
        current = undefined;
        clearTimeout(done.timer);
        if (answer.ok) done.resolve(answer.value);
        else done.reject(new Error(answer.error));
        next();
      };
      port.onmessage = ({ data }) => {
        if (data?.v !== 1) return;
        if (typeof data.kind !== "string") {
          if (current !== undefined && data.re === current.message.id) settle(data);
          return;
        }
        // A call waiting for the person is answered by `until`, not in 15 s.
        if (data.kind === "rpc.waiting" && data.re === current?.message.id) {
          clearTimeout(current.timer);
          current.timer = setTimeout(
            () => settle({ ok: false, error: "No answer from the app" }),
            Math.max(0, Date.parse(data.until) - Date.now()) + 15000,
          );
        }
        if (data.kind === "theme.changed") theme(data.theme);
        // A wait is news only while it lasts, so a later listener is not told of it.
        if (data.kind !== "rpc.waiting") latest.set(data.kind, data);
        for (const listener of listeners) listener(data);
      };
      port.start();
      theme(said.theme);
      const request = (op, fields = {}) =>
        new Promise((resolve, reject) => {
          queue.push({ resolve, reject, message: { ...fields, v: 1, id: String(++sequence), op } });
          next();
        });
      resolve({
        hello: said,
        // A listener first hears the latest push of each kind that came before it.
        on(listener) {
          for (const push of latest.values()) listener(push);
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        request,
        data: () => request("data.get"),
        state: () => request("state.get"),
        setState: (revision, data) => request("state.set", { revision, data }),
        call: (method, input = {}) => request("rpc.call", { method, input }),
        openAgent: (prefill) => request("open-agent", prefill === undefined ? {} : { prefill }),
        resize: (height) =>
          request("resize", { height: Math.min(1200, Math.max(1, Math.ceil(height))) }),
        decline: () => request("decline"),
      });
    });
  });
}
