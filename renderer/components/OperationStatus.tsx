import React from 'react';
import type { OperationState } from '../../shared/operations';
import { isOperationActive, operationPercent } from '../../shared/operations';
import { useTranslation } from '../utils/i18nContext';
import { ProgressBar } from './ProgressBar';

/** Uses the same translated owner state for detailed rows and settings exports. */
export function useOperationText(operation: OperationState) {
  const { t } = useTranslation();
  return {
    stage: t(`operation.stage.${operation.stage}`),
    status: t(`operation.status.${operation.status}`),
    reason: operation.waitingFor ? t(`operation.wait.${operation.waitingFor}`) : null,
    percent: operationPercent(operation),
  };
}
export const OperationStatus: React.FC<{ operation: OperationState; showProgress?: boolean; explanation?: string }> = ({ operation, showProgress = true, explanation }) => {
  const { t } = useTranslation();
  const text = useOperationText(operation);
  return <div className="operation-status" data-operation-stage={operation.stage} data-operation-status={operation.status}>
    <div className="operation-status-heading" role="status">
      <span>{text.stage}</span><span>{text.status}{text.percent === null ? '' : ` · ${text.percent.toFixed(0)}%`}</span>
    </div>
    {showProgress && (isOperationActive(operation) || text.percent !== null) && <ProgressBar value={text.percent === null ? null : text.percent / 100} label={text.stage}
      variant={operation.status === 'failed' ? 'error' : operation.status === 'succeeded' ? 'success' : 'default'} />}
    {(explanation ?? text.reason) && <p className="operation-status-reason">{explanation ?? text.reason}</p>}
    {operation.lastResult && <p className="operation-status-result">{t('operation.lastResult')}: {t(`operation.stage.${operation.lastResult.stage}`)} · {t(`operation.status.${operation.lastResult.status}`)}</p>}
  </div>;
};
