import { useState } from "react";
import { Logo } from "@/components/ui/Logo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { api, ApiError } from "../lib/api";
import { Button } from "../components/ui/primitives";

/**
 * First-run setup. One field, one action — same as before, but using
 * the warm-neutral design tokens so it doesn't feel like a different app.
 */
export default function Setup() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [path, setPath] = useState("");

  const save = useMutation({
    mutationFn: (vaultPath: string) => api.updateConfig({ vault_path: vaultPath }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config"] });
      toast.success("Vault configured");
      navigate("/");
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to save vault path");
    },
  });

  return (
    <div
      className="sv-fade-in"
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "96px 24px",
      }}
    >
      <div style={{ width: "100%", maxWidth: 560 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 32 }}>
          <Logo size={30} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>Skill Vault</span>
        </div>

        <h1
          style={{
            margin: "0 0 8px",
            fontSize: 26,
            fontWeight: 600,
            color: "var(--ink)",
            letterSpacing: "-0.02em",
          }}
        >
          Welcome to Skill Vault
        </h1>
        <p style={{ margin: "0 0 32px", fontSize: 14, color: "var(--ink-2)", lineHeight: 1.6 }}>
          Point at a directory where your skills live. We'll create a{" "}
          <code style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink)" }}>
            skills.json
          </code>{" "}
          inside it if one doesn't exist yet. The same path is used by the{" "}
          <code style={{ fontFamily: "var(--mono)", fontSize: 12 }}>sv</code> CLI.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) save.mutate(path.trim());
          }}
          style={{ display: "flex", flexDirection: "column", gap: 16 }}
        >
          <div>
            <label
              htmlFor="vault-path"
              style={{
                display: "block",
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--ink-3)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontWeight: 600,
                marginBottom: 6,
              }}
            >
              vault directory
            </label>
            <input
              id="vault-path"
              type="text"
              required
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="C:\Users\you\skill-vault"
              autoFocus
              style={{
                width: "100%",
                fontFamily: "var(--mono)",
                fontSize: 13,
                color: "var(--ink)",
                background: "var(--surface)",
                border: "0.5px solid var(--border-2)",
                borderRadius: 6,
                padding: "0 12px",
                height: 36,
                outline: 0,
              }}
            />
            <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--ink-3)", lineHeight: 1.6 }}>
              Absolute path. Will be created if it doesn't exist. Saved to{" "}
              <code style={{ fontFamily: "var(--mono)" }}>~/.skill-vault/config.json</code>.
            </p>
          </div>

          <div>
            <Button
              kind="primary"
              size="md"
              type="submit"
              disabled={!path.trim() || save.isPending}
            >
              {save.isPending ? "Saving…" : "Continue"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
