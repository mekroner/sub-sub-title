import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// StrictMode is intentionally omitted: its double-invoked effects would run the
// ffmpeg peak extraction twice and re-initialise wavesurfer against a shared
// <video> element, which this app cannot do idempotently.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.Fragment>
    <App />
  </React.Fragment>,
);
