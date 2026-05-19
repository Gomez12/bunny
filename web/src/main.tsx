import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import MiniApp from "./MiniApp";
import "highlight.js/styles/github-dark.css";
import "./styles.css";

const isMini =
  new URLSearchParams(window.location.search).get("mini") === "1";

const root = document.getElementById("root")!;
createRoot(root).render(
  <StrictMode>{isMini ? <MiniApp /> : <App />}</StrictMode>,
);
