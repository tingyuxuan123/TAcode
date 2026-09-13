import { randomUUID } from "node:crypto";
import {
  DELEGATION_BRIDGE_EVENT,
  DELEGATION_BRIDGE_REQUEST,
  DELEGATION_BRIDGE_RESPONSE,
  isDelegationBridgeResponse,
  type DelegationAction,
  type DelegationBridgeEvent,
  type DelegationBridgePayload,
  type DelegationBridgeResponse,
  type DelegationRecordSnapshot,
} from "../shared/delegation.js";

export interface RuntimeDelegationClient {
  request(action: DelegationAction, payload: DelegationBridgePayload): Promise<unknown>;
  onEvent(listener: (event: DelegationRecordSnapshot) => void): () => void;
  dispose(): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export function createRuntimeDelegationClient(parentSessionPath?: string): RuntimeDelegationClient | undefined {
  if (typeof process.send !== "function") return undefined;
  const pending = new Map<string, PendingRequest>();
  const listeners = new Set<(event: DelegationRecordSnapshot) => void>();
  /**
   * 进程级前缀：`requestId` 只在本 worker 进程内递增，而父进程侧的请求缓存会跨
   * worker 重启存活。没有前缀时重启后的第一个请求仍是 `delegation-request-1`，
   * 会命中上一代 worker 留下的缓存（父代理据此误判「启动成功」，其实拿到的是旧委派）。
   */
  const clientId = randomUUID().slice(0, 8);
  let requestId = 0;
  const onMessage = (message: unknown): void => {
    if (!message || typeof message !== "object") return;
    const value = message as Record<string, unknown>;
    if (value.type === DELEGATION_BRIDGE_EVENT && value.event && typeof value.event === "object") {
      for (const listener of listeners) listener(value.event as DelegationRecordSnapshot);
      return;
    }
    if (!isDelegationBridgeResponse(message)) return;
    const response = message as DelegationBridgeResponse;
    const current = pending.get(response.requestId);
    if (!current) return;
    pending.delete(response.requestId);
    if (response.ok) current.resolve(response.result);
    else current.reject(new Error(response.error ?? "Delegation request failed."));
  };
  process.on("message", onMessage);

  return {
    request(action, payload) {
      const id = `delegation-request-${clientId}-${++requestId}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const message = {
          type: DELEGATION_BRIDGE_REQUEST,
          requestId: id,
          action,
          parentSessionPath: parentSessionPath ?? process.env.TACODE_PARENT_SESSION_PATH ?? "",
          payload,
        };
        try {
          process.send?.(message, (error) => {
            if (!error) return;
            pending.delete(id);
            reject(error);
          });
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      process.off("message", onMessage);
      const error = new Error("Delegation bridge disposed.");
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      listeners.clear();
    },
  };
}
