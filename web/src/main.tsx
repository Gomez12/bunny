import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "highlight.js/styles/github-dark.css";
import "./styles.css";

const root = document.getElementById("root")!;
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
