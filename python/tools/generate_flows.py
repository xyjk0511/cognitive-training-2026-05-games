from __future__ import annotations
import json
from copy import deepcopy
from pathlib import Path
from a620_gate0.canonical import canonical_sha256

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT/'contracts/test-vectors'
BASE = {
  'contractVersion':'A620-TRC-1.1','systemId':'SYS-001','deviceId':'TAB-01','taskId':'TASK-001','taskItemId':'ITEM-01',
  'executionAttempt':1,'runtimeSessionId':'RUN-001','packageVersion':'1.5.0','coreProtocolVersion':'1.5.0','monotonicEpochId':'BOOT-A'
}
seq={'ANDROID_CONTROLLER':0,'COCOS_RUNTIME':0}
def msg(mt, role, mid, uptime, payload, corr=None, utc='2026-08-17T05:00:00Z'):
  seq[role]+=1
  return {**BASE,'messageType':mt,'messageId':mid,'correlationId':corr,'senderRole':role,'senderSeq':seq[role],'sentAtUtc':utc,'sentAtUptimeMs':uptime,'payload':payload}
def batch(ord_, level_before, zone, transition, level_after, score, closed_ms):
  p={'batchOrdinal':ord_,'closed':True,'decisionEligible':True,'levelBefore':level_before,'resultZone':zone,'levelTransition':transition,'levelAfter':level_after,'batchScore':score,'closedAtActiveMs':closed_ms,'gameBatchMetrics':{'H':8,'T':10,'F':0,'D':0}}
  p['batchPayloadSha256']=canonical_sha256(p)
  return p

def reset():
  seq['ANDROID_CONTROLLER']=0; seq['COCOS_RUNTIME']=0

def complete_flow():
  reset(); f=[]
  config_hash='a'*64
  f.append(msg('PREPARE','ANDROID_CONTROLLER','cmd-1',100,{'clockProfile':'A620-UPTIME-MS-1','durationMs':300000,'sessionSeed':20260817,'sessionStartLevel':1,'designMaxLevel':120,'plannedBatchCount':8,'runtimeConfigHash':config_hash,'scoringRuleVersion':'1.5.0','resultSchemaVersion':'A620-TRR-1.1','generatorVersion':'catch-light-gen-1','gameCode':'CATCH_LIGHT','gameConfigSchemaId':'urn:a620:catch-light:config:1.5','gameConfig':{}}))
  f.append(msg('READY','COCOS_RUNTIME','evt-1',150,{'runtimeConfigHash':config_hash,'plannedBatchCount':8,'runtimeState':'READY'},'cmd-1'))
  f.append(msg('START','ANDROID_CONTROLLER','cmd-2',500,{'effectiveStartUptimeMs':1000,'cutoffUptimeMs':301000,'activeElapsedMs':0,'clockRevision':1,'commandLeadTimeMs':500}))
  f.append(msg('COMMAND_ACCEPTED','COCOS_RUNTIME','evt-2',550,{'acceptedMessageType':'START','effectiveAtUptimeMs':1000,'runtimeState':'START_SCHEDULED','clockRevision':1},'cmd-2'))
  f.append(msg('STARTED','COCOS_RUNTIME','evt-3',1000,{'effectiveStartUptimeMs':1000,'cutoffUptimeMs':301000,'runtimeState':'RUNNING','clockRevision':1},'cmd-2'))
  batches=[]
  for i in range(1,8):
    b=batch(i,i,'UPGRADE','UP',i+1,100,i*37500)
    batches.append(b)
    f.append(msg('BATCH_CLOSED','COCOS_RUNTIME',f'evt-b{i}',1000+i*37500,b))
  # Pause after batch 1, preserving semantic time in example.
  # This flow intentionally omits pause to keep exact cutoff simple; pause has a separate valid flow.
  f.append(msg('DEADLINE','ANDROID_CONTROLLER','cmd-deadline',301000,{'cutoffUptimeMs':301000,'activeElapsedMs':300000,'clockRevision':1}))
  gp={'gameCode':'CATCH_LIGHT','gamePayloadVersion':'A620-GP-1.1','runtimeConfigHash':config_hash,'plannedBatchCount':8,'eligibleBatchCount':7,'eligibleBatches':batches,'incompleteBatchAudit':[{'batchOrdinal':8,'cutoffReason':'DEADLINE','startedAtActiveMs':262500,'cutoffAtActiveMs':300000,'partialMetrics':{'waveOrdinal':8}}], 'sessionStartLevel':1,'sessionEndLevel':8,'sessionHighestPresentedLevel':8,'sessionHighestPassedLevel':7,'nextStartLevel':8,'sessionRawScore':700,'sessionRawScoreMax':800,'actualTrainingMs':300000,'gameMetrics':{'totalTouches':70}}
  gp_hash=canonical_sha256(gp)
  f.append(msg('RESULT_READY','COCOS_RUNTIME','evt-result',301010,{'resultDraftSha256':gp_hash,'gamePayload':gp}))
  f.append(msg('ACK_RESULT_COMMITTED','ANDROID_CONTROLLER','cmd-ack',301020,{'resultId':'RES-001','resultPayloadSha256':gp_hash,'committedAtUtc':'2026-08-17T05:05:01Z','committedAtUptimeMs':301020},'evt-result'))
  return f

def pause_flow():
  reset(); f=[]; config_hash='b'*64
  f.append(msg('PREPARE','ANDROID_CONTROLLER','p-cmd-1',100,{'clockProfile':'A620-UPTIME-MS-1','durationMs':300000,'sessionSeed':1,'sessionStartLevel':1,'designMaxLevel':96,'plannedBatchCount':8,'runtimeConfigHash':config_hash,'scoringRuleVersion':'1.2.1','resultSchemaVersion':'A620-TRR-1.1','generatorVersion':'signal-gen-1','gameCode':'SIGNAL_STATION','gameConfigSchemaId':'urn:a620:signal:config:1.2.1','gameConfig':{}}))
  f.append(msg('READY','COCOS_RUNTIME','p-evt-1',150,{'runtimeConfigHash':config_hash,'plannedBatchCount':8,'runtimeState':'READY'},'p-cmd-1'))
  f.append(msg('START','ANDROID_CONTROLLER','p-cmd-2',500,{'effectiveStartUptimeMs':1000,'cutoffUptimeMs':301000,'activeElapsedMs':0,'clockRevision':1,'commandLeadTimeMs':500}))
  f.append(msg('COMMAND_ACCEPTED','COCOS_RUNTIME','p-evt-2',550,{'acceptedMessageType':'START','effectiveAtUptimeMs':1000,'runtimeState':'START_SCHEDULED','clockRevision':1},'p-cmd-2'))
  f.append(msg('STARTED','COCOS_RUNTIME','p-evt-3',1000,{'effectiveStartUptimeMs':1000,'cutoffUptimeMs':301000,'runtimeState':'RUNNING','clockRevision':1},'p-cmd-2'))
  f.append(msg('PAUSE','ANDROID_CONTROLLER','p-cmd-3',60000,{'effectivePauseUptimeMs':60300,'activeElapsedMs':59300,'clockRevision':2,'pauseLeadTimeMs':300,'reasonCode':'THERAPIST_PAUSE'}))
  f.append(msg('COMMAND_ACCEPTED','COCOS_RUNTIME','p-evt-4',60050,{'acceptedMessageType':'PAUSE','effectiveAtUptimeMs':60300,'runtimeState':'PAUSE_SCHEDULED','clockRevision':2},'p-cmd-3'))
  f.append(msg('PAUSED','COCOS_RUNTIME','p-evt-5',60300,{'effectivePauseUptimeMs':60300,'activeElapsedMs':59300,'runtimeState':'PAUSED','clockRevision':2},'p-cmd-3'))
  f.append(msg('RESUME','ANDROID_CONTROLLER','p-cmd-4',65000,{'countdownMs':3000,'resumeInputEnabledUptimeMs':68000,'cutoffUptimeMs':308700,'activeElapsedMs':59300,'clockRevision':3}))
  f.append(msg('COMMAND_ACCEPTED','COCOS_RUNTIME','p-evt-6',65050,{'acceptedMessageType':'RESUME','effectiveAtUptimeMs':68000,'runtimeState':'RESUME_SCHEDULED','clockRevision':3},'p-cmd-4'))
  f.append(msg('RESUMED','COCOS_RUNTIME','p-evt-7',68000,{'resumeInputEnabledUptimeMs':68000,'cutoffUptimeMs':308700,'activeElapsedMs':59300,'runtimeState':'RUNNING','clockRevision':3},'p-cmd-4'))
  f.append(msg('DEADLINE','ANDROID_CONTROLLER','p-cmd-d',308700,{'cutoffUptimeMs':308700,'activeElapsedMs':300000,'clockRevision':3}))
  gp={'gameCode':'SIGNAL_STATION','gamePayloadVersion':'A620-GP-1.1','runtimeConfigHash':config_hash,'plannedBatchCount':8,'eligibleBatchCount':0,'eligibleBatches':[],'incompleteBatchAudit':[{'batchOrdinal':1,'cutoffReason':'DEADLINE','startedAtActiveMs':0,'cutoffAtActiveMs':300000,'partialMetrics':{}}], 'sessionStartLevel':1,'sessionEndLevel':1,'sessionHighestPresentedLevel':1,'sessionHighestPassedLevel':None,'nextStartLevel':1,'sessionRawScore':0,'sessionRawScoreMax':800,'actualTrainingMs':300000,'gameMetrics':{}}
  h=canonical_sha256(gp)
  f.append(msg('RESULT_READY','COCOS_RUNTIME','p-evt-r',308710,{'resultDraftSha256':h,'gamePayload':gp}))
  f.append(msg('ACK_RESULT_COMMITTED','ANDROID_CONTROLLER','p-cmd-a',308720,{'resultId':'RES-P','resultPayloadSha256':h,'committedAtUtc':'2026-08-17T05:05:08Z','committedAtUptimeMs':308720},'p-evt-r'))
  return f

def terminated_flow():
  reset(); f=[]; ch='c'*64
  f.append(msg('PREPARE','ANDROID_CONTROLLER','t-c1',100,{'clockProfile':'A620-UPTIME-MS-1','durationMs':300000,'sessionSeed':1,'sessionStartLevel':1,'designMaxLevel':120,'plannedBatchCount':8,'runtimeConfigHash':ch,'scoringRuleVersion':'1','resultSchemaVersion':'A620-TRR-1.1','generatorVersion':'g1','gameCode':'CATCH_LIGHT','gameConfigSchemaId':'urn:test','gameConfig':{}}))
  f.append(msg('READY','COCOS_RUNTIME','t-e1',150,{'runtimeConfigHash':ch,'plannedBatchCount':8,'runtimeState':'READY'},'t-c1'))
  f.append(msg('START','ANDROID_CONTROLLER','t-c2',500,{'effectiveStartUptimeMs':1000,'cutoffUptimeMs':301000,'activeElapsedMs':0,'clockRevision':1,'commandLeadTimeMs':500}))
  f.append(msg('COMMAND_ACCEPTED','COCOS_RUNTIME','t-e2',550,{'acceptedMessageType':'START','effectiveAtUptimeMs':1000,'runtimeState':'START_SCHEDULED','clockRevision':1},'t-c2'))
  f.append(msg('STARTED','COCOS_RUNTIME','t-e3',1000,{'effectiveStartUptimeMs':1000,'cutoffUptimeMs':301000,'runtimeState':'RUNNING','clockRevision':1},'t-c2'))
  f.append(msg('TERMINATE','ANDROID_CONTROLLER','t-c3',2000,{'effectiveTerminateUptimeMs':2200,'clockRevision':2,'reasonCode':'MANAGER_TERMINATE'}))
  f.append(msg('COMMAND_ACCEPTED','COCOS_RUNTIME','t-e4',2050,{'acceptedMessageType':'TERMINATE','effectiveAtUptimeMs':2200,'runtimeState':'TERMINATING','clockRevision':2},'t-c3'))
  f.append(msg('TERMINATED','COCOS_RUNTIME','t-e5',2200,{'effectiveTerminateUptimeMs':2200,'runtimeState':'TERMINATED','reasonCode':'MANAGER_TERMINATE'},'t-c3'))
  return f

def error_flow():
  f=terminated_flow()[:5]
  # replace after STARTED with autonomous fatal error; adjust seq from existing flow.
  f.append({**BASE,'messageType':'RUNTIME_ERROR','messageId':'x-e4','correlationId':None,'senderRole':'COCOS_RUNTIME','senderSeq':4,'sentAtUtc':'2026-08-17T05:00:02Z','sentAtUptimeMs':2000,'payload':{'errorCode':'A620-RUNTIME-CRASH','fatal':True,'runtimeState':'RUNNING','details':{}}})
  return f

def same_time_terminate_flow():
  flow=complete_flow()
  # Keep only through STARTED, then terminate exactly at the scheduled cutoff.
  flow=flow[:5]
  flow.append({**BASE,'messageType':'TERMINATE','messageId':'st-cmd','correlationId':None,'senderRole':'ANDROID_CONTROLLER','senderSeq':3,'sentAtUtc':'2026-08-17T05:05:01Z','sentAtUptimeMs':301000,'payload':{'effectiveTerminateUptimeMs':301000,'clockRevision':2,'reasonCode':'MANAGER_TERMINATE'}})
  flow.append({**BASE,'messageType':'COMMAND_ACCEPTED','messageId':'st-evt-a','correlationId':'st-cmd','senderRole':'COCOS_RUNTIME','senderSeq':4,'sentAtUtc':'2026-08-17T05:05:01Z','sentAtUptimeMs':301000,'payload':{'acceptedMessageType':'TERMINATE','effectiveAtUptimeMs':301000,'runtimeState':'TERMINATING','clockRevision':2}})
  flow.append({**BASE,'messageType':'TERMINATED','messageId':'st-evt-t','correlationId':'st-cmd','senderRole':'COCOS_RUNTIME','senderSeq':5,'sentAtUtc':'2026-08-17T05:05:01Z','sentAtUptimeMs':301000,'payload':{'effectiveTerminateUptimeMs':301000,'runtimeState':'TERMINATED','reasonCode':'MANAGER_TERMINATE'}})
  return flow

for name,flow,expected in [('valid_complete_flow',complete_flow(),'COMPLETE'),('valid_pause_complete_flow',pause_flow(),'COMPLETE'),('valid_terminated_flow',terminated_flow(),'TERMINATED'),('valid_same_time_terminate_flow',same_time_terminate_flow(),'TERMINATED'),('valid_error_flow',error_flow(),'ERROR')]:
  (OUT/f'{name}.json').write_text(json.dumps({'expectedOutcome':expected,'messages':flow},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

# Generate adversarial mutations from valid complete flow.
base=complete_flow()
mutations={}
mutations['invalid_missing_start_accepted']=[m for m in base if m['messageId']!='evt-2']
mutations['invalid_ready_hash']=deepcopy(base); mutations['invalid_ready_hash'][1]['payload']['runtimeConfigHash']='f'*64
mutations['invalid_started_cutoff']=deepcopy(base); mutations['invalid_started_cutoff'][4]['payload']['cutoffUptimeMs']+=1
mutations['invalid_result_from_running']=deepcopy([m for m in base if m['messageType'] not in {'DEADLINE'}]); next(m for m in mutations['invalid_result_from_running'] if m['messageType']=='RESULT_READY')['sentAtUptimeMs']=300999
mutations['invalid_batch_evidence_replaced']=deepcopy(base); rr=mutations['invalid_batch_evidence_replaced'][-2]; rr['payload']['gamePayload']['eligibleBatches']=[deepcopy(x) for x in rr['payload']['gamePayload']['eligibleBatches']]; rr['payload']['gamePayload']['eligibleBatches'][0]['batchScore']=99; gp=rr['payload']['gamePayload']; gp['sessionRawScore']=699; gp['eligibleBatches'][0]['batchPayloadSha256']=canonical_sha256({k:v for k,v in gp['eligibleBatches'][0].items() if k!='batchPayloadSha256'}); rr['payload']['resultDraftSha256']=canonical_sha256(gp); mutations['invalid_batch_evidence_replaced'][-1]['payload']['resultPayloadSha256']=canonical_sha256(gp)
mutations['invalid_ack_hash']=deepcopy(base); mutations['invalid_ack_hash'][-1]['payload']['resultPayloadSha256']='0'*64
mutations['invalid_sender_time_backwards']=deepcopy(base); mutations['invalid_sender_time_backwards'][4]['sentAtUptimeMs']=500
mutations['invalid_heartbeat_state']=deepcopy(base); hb=msg('HEARTBEAT','COCOS_RUNTIME','hb-bad',2000,{'runtimeState':'RESULT_COMMITTED','activeElapsedMs':1000,'clockRevision':1,'lastAppliedControllerSeq':2}); mutations['invalid_heartbeat_state'].insert(5,hb)
mutations['invalid_query_without_snapshot']=deepcopy(base); q={**BASE,'messageType':'QUERY_STATE','messageId':'q-cmd','correlationId':None,'senderRole':'ANDROID_CONTROLLER','senderSeq':3,'sentAtUtc':'2026-08-17T05:00:01Z','sentAtUptimeMs':1500,'payload':{}}; mutations['invalid_query_without_snapshot'].insert(5,q); [m.__setitem__('senderSeq',m['senderSeq']+1) for m in mutations['invalid_query_without_snapshot'][6:] if m['senderRole']=='ANDROID_CONTROLLER']
for name,flow in mutations.items():
  (OUT/f'{name}.json').write_text(json.dumps({'expectedOutcome':'REJECT','messages':flow},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
