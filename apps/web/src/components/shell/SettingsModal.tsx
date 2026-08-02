import { KeyRound, Server, Settings2, ShieldCheck, X } from "lucide-react";
import type { LlmApiKeySource } from "@constelix/contracts";
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
    window.requestAnimationFrame(() => baseUrlRef.current?.focus());
  }, [initialBaseUrl, initialModel, open]);

  if (!open) return null;

  const close = () => {
    if (busy) return;
    if (apiKeyRef.current) apiKeyRef.current.value = "";
    onClose();
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading || loadError) return;
    const normalizedBaseUrl = baseUrl.trim().replace(/\/$/, "");
    const baseUrlError = validateLlmBaseUrl(normalizedBaseUrl);
    if (baseUrlError) {
      setError(baseUrlError);
      baseUrlRef.current?.focus();
      return;
    }
    if (!model.trim()) {
      setError("Introduce el identificador del modelo.");
      return;
    }
    setBusy(true);
    setError(null);
    const apiKey = apiKeyRef.current?.value.trim();
    try {
      await onSave?.({
        baseUrl: normalizedBaseUrl,
        model: model.trim(),
        ...(apiKey ? { apiKey } : {}),
        ...(!apiKey && clearApiKey ? { clearApiKey: true } : {}),
      });
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

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled)",
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
        aria-label="Configuración de LLM"
        onKeyDown={handleDialogKeyDown}
      >
        <header className="settings-modal__header">
          <span className="settings-modal__icon">
            <Settings2 aria-hidden="true" size={17} />
          </span>
          <div>
            <strong>Configuración de LLM</strong>
            <span>Conecta un proveedor local o compatible con OpenAI.</span>
          </div>
          <button type="button" aria-label="Cerrar configuración" onClick={close}>
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <form className="settings-modal__form" onSubmit={(event) => void handleSubmit(event)}>
          <label>
            <span><Server aria-hidden="true" size={13} /> URL base del LLM</span>
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
              }}
            />
          </label>
          <label>
            <span><KeyRound aria-hidden="true" size={13} /> Clave de API (opcional)</span>
            <input
              ref={apiKeyRef}
              name="llmApiKey"
              type="password"
              autoComplete="new-password"
              disabled={clearApiKey}
              placeholder={apiKeyConfigured ? "Clave configurada para este endpoint" : "No requerida por Ollama local"}
              onChange={() => setClearApiKey(false)}
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
            <button type="button" onClick={close} disabled={busy}>Cancelar</button>
            <button type="submit" disabled={busy || loading || Boolean(loadError)}>
              {busy ? "Guardando…" : loading ? "Cargando…" : "Guardar configuración"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
});
