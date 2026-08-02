import {
  CheckCircle2,
  KeyRound,
  Monitor,
  Palette,
  PlugZap,
  Server,
  Settings2,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import type {
  LlmApiKeySource,
  LlmConnectionTestResponse,
} from "@constelix/contracts";
import {
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  isLoopbackLlmBaseUrl,
  validateLlmBaseUrl,
} from "../../lib/llmSettings";
import { useShellStore } from "../../store/useShellStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";

export interface LlmSettingsDraft {
  baseUrl: string;
  model: string;
  /** Undefined means preserve the key already held by the local agent. */
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface SettingsModalProps {
  open: boolean;
  loading?: boolean;
  loadError?: string | undefined;
  initialBaseUrl?: string;
  initialModel?: string;
  apiKeyConfigured?: boolean;
  apiKeySource?: LlmApiKeySource;
  onClose: () => void;
  onRetryLoad?: () => void;
  onSave?: (settings: LlmSettingsDraft) => Promise<void>;
  onTest?: (
    settings: LlmSettingsDraft,
  ) => Promise<LlmConnectionTestResponse>;
}

export const SettingsModal = memo(function SettingsModal({
  open,
  loading = false,
  loadError,
  initialBaseUrl = DEFAULT_LLM_BASE_URL,
  initialModel = DEFAULT_LLM_MODEL,
  apiKeyConfigured = false,
  apiKeySource = "none",
  onClose,
  onRetryLoad,
  onSave,
  onTest,
}: SettingsModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const baseUrlRef = useRef<HTMLInputElement>(null);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const baseUrlDirtyRef = useRef(false);
  const modelDirtyRef = useRef(false);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [model, setModel] = useState(initialModel);
  const [busy, setBusy] = useState(false);
  const [clearApiKey, setClearApiKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] =
    useState<LlmConnectionTestResponse | null>(null);
  const themeMode = useShellStore((state) => state.themeMode);
  const setThemeMode = useShellStore((state) => state.setThemeMode);
  const textScale = useShellStore((state) => state.textScale);
  const setTextScale = useShellStore((state) => state.setTextScale);
  const actAvailable = useWorkspaceStore((state) => state.actAvailable);
  const codexChecking = useWorkspaceStore((state) => state.codexChecking);
  const codexReason = useWorkspaceStore((state) => state.codexReason);
  const codexVersion = useWorkspaceStore((state) => state.codexVersion);

  useLayoutEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) {
      setBaseUrl((current) =>
        baseUrlDirtyRef.current ? current : initialBaseUrl
      );
      setModel((current) =>
        modelDirtyRef.current ? current : initialModel
      );
      return;
    }
    wasOpenRef.current = true;
    baseUrlDirtyRef.current = false;
    modelDirtyRef.current = false;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setBaseUrl(initialBaseUrl);
    setModel(initialModel);
    setBusy(false);
    setClearApiKey(false);
    setError(null);
    setTestBusy(false);
    setTestResult(null);
    window.requestAnimationFrame(() => baseUrlRef.current?.focus());
  }, [initialBaseUrl, initialModel, open]);

  if (!open) return null;

  const close = () => {
    if (busy || testBusy) return;
    if (apiKeyRef.current) apiKeyRef.current.value = "";
    onClose();
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  };

  const validatedDraft = (): LlmSettingsDraft | null => {
    if (loading || loadError) return null;
    const normalizedBaseUrl = baseUrl.trim().replace(/\/$/, "");
    const baseUrlError = validateLlmBaseUrl(normalizedBaseUrl);
    if (baseUrlError) {
      setError(baseUrlError);
      baseUrlRef.current?.focus();
      return null;
    }
    if (!model.trim()) {
      setError("Introduce el identificador del modelo.");
      return null;
    }
    const apiKey = apiKeyRef.current?.value.trim();
    return {
      baseUrl: normalizedBaseUrl,
      model: model.trim(),
      ...(apiKey ? { apiKey } : {}),
      ...(!apiKey && clearApiKey ? { clearApiKey: true } : {}),
    };
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const draft = validatedDraft();
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await onSave?.(draft);
      if (apiKeyRef.current) apiKeyRef.current.value = "";
      onClose();
      window.requestAnimationFrame(() => returnFocusRef.current?.focus());
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "No se pudo guardar la configuración.",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    const draft = validatedDraft();
    if (!draft || !onTest) return;
    setTestBusy(true);
    setError(null);
    setTestResult(null);
    try {
      setTestResult(await onTest(draft));
    } catch (testError) {
      setError(
        testError instanceof Error
          ? testError.message
          : "No se pudo comprobar el proveedor.",
      );
    } finally {
      setTestBusy(false);
    }
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
      ) ?? [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const localEndpoint = isLoopbackLlmBaseUrl(baseUrl);
  const providerPreset = localEndpoint
    ? "ollama"
    : baseUrl.includes("api.openai.com")
      ? "openai"
      : "compatible";
  const applyProviderPreset = (provider: "openai" | "ollama" | "compatible") => {
    baseUrlDirtyRef.current = true;
    modelDirtyRef.current = true;
    setTestResult(null);
    if (provider === "openai") {
      setBaseUrl(DEFAULT_LLM_BASE_URL);
      setModel(DEFAULT_LLM_MODEL);
    } else if (provider === "ollama") {
      setBaseUrl("http://127.0.0.1:11434/v1");
      setModel("qwen2.5-coder:7b");
    } else {
      window.requestAnimationFrame(() => baseUrlRef.current?.focus());
    }
  };
  const providerChanged =
    baseUrl.trim().replace(/\/$/u, "") !==
    initialBaseUrl.trim().replace(/\/$/u, "");

  return (
    <div
      className="settings-modal-backdrop"
      data-testid="settings-modal"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Configuración de Constelix"
        onKeyDown={handleDialogKeyDown}
      >
        <header className="settings-modal__header">
          <span className="settings-modal__icon">
            <Settings2 aria-hidden="true" size={17} />
          </span>
          <div>
            <strong>Configuración</strong>
            <span>Proveedor, apariencia y capacidades locales.</span>
          </div>
          <button type="button" aria-label="Cerrar configuración" onClick={close}>
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <form className="settings-modal__form" onSubmit={(event) => void handleSubmit(event)}>
          <section className="settings-modal__section" aria-labelledby="provider-settings-title">
            <div className="settings-modal__section-heading">
              <Server aria-hidden="true" size={15} />
              <div><strong id="provider-settings-title">Proveedor de IA</strong><span>La búsqueda local funciona aunque no conectes un LLM.</span></div>
            </div>
            <div className="provider-presets" aria-label="Proveedores preconfigurados">
              {(["openai", "ollama", "compatible"] as const).map((provider) => (
                <button
                  key={provider}
                  type="button"
                  aria-pressed={providerPreset === provider}
                  onClick={() => applyProviderPreset(provider)}
                >
                  {provider === "openai" ? "OpenAI" : provider === "ollama" ? "Ollama local" : "Compatible"}
                </button>
              ))}
            </div>
          <label>
            <span>URL base del LLM</span>
            <input
              ref={baseUrlRef}
              name="llmBaseUrl"
              type="url"
              value={baseUrl}
              autoComplete="url"
              spellCheck={false}
              placeholder="https://api.openai.com/v1"
              onChange={(event) => {
                baseUrlDirtyRef.current = true;
                setBaseUrl(event.target.value);
                setTestResult(null);
              }}
            />
          </label>
          <label>
            <span>Modelo</span>
            <input
              name="llmModel"
              value={model}
              autoComplete="off"
              spellCheck={false}
              placeholder="gpt-4o"
              onChange={(event) => {
                modelDirtyRef.current = true;
                setModel(event.target.value);
                setTestResult(null);
              }}
            />
          </label>
          <label>
            <span><KeyRound aria-hidden="true" size={13} /> {localEndpoint ? "Clave API (no requerida en local)" : "Clave API (requerida para proveedor remoto)"}</span>
            <input
              ref={apiKeyRef}
              name="llmApiKey"
              type="password"
              autoComplete="new-password"
              disabled={clearApiKey}
              placeholder={
                apiKeyConfigured
                  ? "Clave configurada para este endpoint"
                  : localEndpoint
                    ? "No requerida por Ollama local"
                    : "Introduce la clave del proveedor"
              }
              onChange={() => {
                setClearApiKey(false);
                setTestResult(null);
              }}
            />
          </label>
          {apiKeyConfigured && apiKeySource === "stored" ? (
            <button
              className="settings-modal__clear-key"
              type="button"
              aria-pressed={clearApiKey}
              onClick={() => {
                setClearApiKey((value) => !value);
                if (apiKeyRef.current) apiKeyRef.current.value = "";
              }}
            >
              {clearApiKey
                ? "La clave guardada se eliminará al guardar"
                : "Eliminar la clave guardada"}
            </button>
          ) : null}
          {apiKeyConfigured && apiKeySource === "environment" ? (
            <p className="settings-modal__key-source">
              La clave proviene del entorno del agente y debe cambiarse allí.
            </p>
          ) : null}
          {apiKeyConfigured && apiKeySource === "stored" && providerChanged ? (
            <p className="settings-modal__key-source">
              Al cambiar de endpoint, la clave anterior se elimina. Introduce una
              nueva clave si el destino la requiere.
            </p>
          ) : null}
          <p className="settings-modal__security">
            <ShieldCheck aria-hidden="true" size={14} />
            {localEndpoint
              ? "El endpoint apunta a esta máquina."
              : "La URL apunta a un proveedor externo; revisa qué código compartes."}
            {" "}La clave es de solo escritura y nunca se persiste en el navegador.
          </p>
          {testResult ? (
            <p
              className={`settings-modal__test-result settings-modal__test-result--${testResult.ok ? "success" : "failure"}`}
              role="status"
            >
              {testResult.ok ? <CheckCircle2 aria-hidden="true" size={15} /> : <TriangleAlert aria-hidden="true" size={15} />}
              <span>{testResult.message} <small>{testResult.latencyMs} ms</small></span>
            </p>
          ) : null}
          </section>

          <section className="settings-modal__section" aria-labelledby="appearance-settings-title">
            <div className="settings-modal__section-heading">
              <Palette aria-hidden="true" size={15} />
              <div><strong id="appearance-settings-title">Apariencia</strong><span>Ajusta contraste y escala sin perder espacio de trabajo.</span></div>
            </div>
            <div className="settings-modal__appearance-grid">
              <label>
                <span><Monitor aria-hidden="true" size={13} /> Tema</span>
                <select value={themeMode} onChange={(event) => setThemeMode(event.target.value as "dark" | "light" | "system")}>
                  <option value="dark">Oscuro</option>
                  <option value="light">Claro</option>
                  <option value="system">Usar sistema</option>
                </select>
              </label>
              <label>
                <span>Escala de texto</span>
                <select value={textScale} onChange={(event) => setTextScale(event.target.value as "default" | "large")}>
                  <option value="default">Cómoda</option>
                  <option value="large">Grande</option>
                </select>
              </label>
            </div>
          </section>

          <section className="settings-modal__section settings-modal__codex" aria-labelledby="codex-settings-title">
            <div className="settings-modal__section-heading">
              <PlugZap aria-hidden="true" size={15} />
              <div>
                <strong id="codex-settings-title">Codex local</strong>
                <span>
                  {codexChecking
                    ? "Comprobando la instalación…"
                    : actAvailable
                      ? `Listo${codexVersion ? ` · versión ${codexVersion}` : ""}`
                      : codexReason ?? "Instala la versión compatible de Codex CLI para habilitar Actuar."}
                </span>
              </div>
            </div>
          </section>
          {error ? <p className="settings-modal__error" role="alert">{error}</p> : null}
          {loading ? (
            <p className="settings-modal__key-source" role="status">
              Cargando la configuración segura del agente…
            </p>
          ) : null}
          {loadError ? (
            <div className="settings-modal__load-error">
              <p className="settings-modal__error" role="alert">{loadError}</p>
              <button type="button" onClick={onRetryLoad}>
                Reintentar carga
              </button>
            </div>
          ) : null}
          <footer className="settings-modal__actions">
            <button
              type="button"
              className="settings-modal__test"
              disabled={busy || testBusy || loading || Boolean(loadError) || !onTest}
              onClick={() => void handleTest()}
            >
              <PlugZap aria-hidden="true" size={14} /> {testBusy ? "Comprobando…" : "Probar sin guardar"}
            </button>
            <span className="settings-modal__action-spacer" />
            <button type="button" onClick={close} disabled={busy || testBusy}>Cancelar</button>
            <button type="submit" disabled={busy || testBusy || loading || Boolean(loadError)}>
              {busy ? "Guardando…" : loading ? "Cargando…" : "Guardar configuración"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
});
