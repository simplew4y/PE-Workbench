import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionFlow, renderFlowHtml, renderFlowSvg } from './execution-flow.ts';

const entry = (id, parentId, seconds, message) => ({id,parentId,type:'message',timestamp:new Date(seconds*1000).toISOString(),message});
test('pairs calls, preserves failures and excludes sibling branches and next question', () => {
  const entries = [entry('u',null,0,{role:'user',content:'q'}),entry('a','u',5,{role:'assistant',content:[{type:'toolCall',id:'c',name:'read',arguments:{file:'x'}}]}),entry('r','a',6,{role:'toolResult',toolCallId:'c',isError:true,content:'missing'}),entry('sibling','u',7,{role:'assistant',content:[{type:'text',text:'wrong branch'}]}),entry('a2','r',10,{role:'assistant',content:[{type:'text',text:'answer'}]}),entry('u2','a2',100,{role:'user',content:'next'})];
  const flow = buildExecutionFlow(entries,'s','u','u2');
  assert.equal(flow.steps.length,4);
  assert.equal(flow.steps[1].durationMs,5000);
  assert.equal(flow.steps[2].durationMs,1000);
  assert.equal(flow.steps[2].status,'失败');
  assert.equal(flow.steps[3].durationMs,4000);
  assert.doesNotMatch(JSON.stringify(flow),/wrong branch|next/);
});
test('unreturned calls remain unknown, outputs escaped, secrets and thinking excluded', () => {
  const flow=buildExecutionFlow([entry('u',null,0,{role:'user',content:'<script>alert(1)</script>'}),entry('a','u',3,{role:'assistant',content:[{type:'thinking',thinking:'private reasoning'},{type:'toolCall',id:'c',name:'read',arguments:{password:'secret-value'}}]})],'s','u','a');
  assert.equal(flow.steps[2].status,'未记录返回');
  assert.equal(flow.steps[2].durationMs,null);
  assert.doesNotMatch(JSON.stringify(flow),/secret-value|private reasoning/);
  assert.doesNotMatch(renderFlowHtml(flow),/<script>/);
  assert.match(renderFlowHtml(flow),/&lt;script&gt;/);
  assert.match(renderFlowSvg(flow),/<svg/);
});
test('rejects missing turn, broken and cyclic branches', () => {
  assert.throws(()=>buildExecutionFlow([], 's','u','a'));
  assert.throws(()=>buildExecutionFlow([entry('a','a',0,{})],'s','u','a'));
  assert.throws(()=>buildExecutionFlow([entry('a',null,0,{role:'assistant'})],'s','a','a'));
});
