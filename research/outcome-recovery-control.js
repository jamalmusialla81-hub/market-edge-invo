'use strict';

// Outcome labels are terminal research facts, separate from immutable signal
// inputs. A terminal unresolved result is useful provenance, not a batch
// failure and never becomes supervised training data.
const TERMINAL_STATUSES=new Set(['RESOLVED','UNRESOLVED_DATA_GAP','UNRESOLVED_INSUFFICIENT_FUTURE_DATA','UNRESOLVED_SOURCE_UNAVAILABLE']);
const isTerminalStatus=status=>TERMINAL_STATUSES.has(String(status||''));
function assertOutcomeIntegrity(target){
  if(!target||!isTerminalStatus(target.status))throw new Error('OUTCOME_NOT_TERMINAL');
  // Malformed proxy OHLC is a source-integrity failure, not ordinary missing
  // history, and must stop rather than silently manufacture a terminal label.
  if(target.reason==='BINANCE_PROXY_INVALID_OHLC')throw new Error('MALFORMED_OUTCOME_OHLC');
  return true;
}
function summarise(results,{noLookahead=true,frozenInputsImmutable=true}={}){
  if(!noLookahead)throw new Error('LOOKAHEAD_REJECTED');
  if(!frozenInputsImmutable)throw new Error('FROZEN_INPUT_MUTATION');
  const rows=Array.isArray(results)?results:[];
  for(const result of rows)assertOutcomeIntegrity(result);
  const resolved=rows.filter(row=>row.status==='RESOLVED').length;
  const terminalUnresolved=rows.length-resolved;
  return {batch_continue:true,resolved,terminal_unresolved:terminalUnresolved,training_eligible:resolved};
}
function completedScanIds(rows){
  return new Set((Array.isArray(rows)?rows:[]).filter(row=>Number(row.pending_rankable||0)===0).map(row=>String(row.scan_id)));
}
module.exports={TERMINAL_STATUSES,isTerminalStatus,assertOutcomeIntegrity,summarise,completedScanIds};
