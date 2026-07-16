import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "@xterm/xterm/css/xterm.css";

import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("No se encontró el contenedor raíz de Constelix.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
