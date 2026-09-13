import { useEffect, useState } from "react";
import type { DelegationRecordSnapshot } from "../shared/delegation";
import type { DelegationRecords } from "./delegation-state";

/** 独立于父会话的消息流：后台委派完成、父会话停止及重载后仍能得到实际状态。 */
export function useDelegationState(): DelegationRecords {
  const [records, setRecords] = useState<Map<string, DelegationRecordSnapshot>>(() => new Map());
  useEffect(() => {
    const api = window.harness.delegations;
    if (!api) return;
    let gone = false;
    const received = new Set<string>();
    const off = api.onEvent((record) => {
      received.add(record.delegationId);
      setRecords((current) => new Map(current).set(record.delegationId, record));
    });
    void api.list().then((snapshots) => {
      if (gone) return;
      setRecords((current) => {
        const next = new Map(current);
        for (const record of snapshots) {
          if (!received.has(record.delegationId)) next.set(record.delegationId, record);
        }
        return next;
      });
    }).catch(() => undefined);
    return () => { gone = true; off(); };
  }, []);
  return records;
}
