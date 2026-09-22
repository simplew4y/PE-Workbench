"""Small stdlib validator for shared research state, not a financial audit."""
import json
from pathlib import Path
import sys

COLLECTIONS = 'sources evidence metrics assumptions model_checks theses forecasts valuations sensitivities return_paths monitoring gaps changes artifacts'.split()
TARGETS = {'source_ids':'sources','evidence_ids':'evidence','support_ids':'evidence','counter_ids':'evidence','assumption_ids':'assumptions','thesis_ids':'theses','affected_thesis_ids':'theses','valuation_ids':'valuations'}

def validate(s, base):
    errors=[]
    if not isinstance(s,dict): return ['State must be an object']
    if s.get('schema_version') not in (1, 2): errors.append('schema_version must be 1 or 2')
    if type(s.get('revision')) is not int or s['revision'] < 1: errors.append('revision must be a positive integer')
    if s.get('stage') not in ('partial','draft','reviewed_draft','needs_revision'): errors.append('Invalid stage')
    for name in ('context','business','market','review'):
        if not isinstance(s.get(name),dict): errors.append(f'{name} must be an object')
    ctx=s.get('context',{})
    if isinstance(ctx,dict):
        for key in ('company','objective','cutoff','currency'):
            if not ctx.get(key): errors.append(f'Missing context.{key}')
    ids={k:set() for k in COLLECTIONS}; all_ids=set()
    for k in COLLECTIONS:
        rows=s.get(k)
        if not isinstance(rows,list): errors.append(f'{k} must be an array');continue
        for row in rows:
            if not isinstance(row,dict) or not isinstance(row.get('id'),str) or not row['id']:
                errors.append(f'{k}: missing string id');continue
            rid=row['id']
            if rid in all_ids: errors.append(f'Duplicate ID: {rid}')
            ids[k].add(rid);all_ids.add(rid)
    def walk(x):
        if isinstance(x,dict):
            for k,v in x.items():
                if k in TARGETS:
                    if not isinstance(v,list): errors.append(f'{k} must be an array')
                    else:
                        for rid in v:
                            if not isinstance(rid,str) or rid not in ids[TARGETS[k]]: errors.append(f'Unresolved {k}: {rid}')
                else: walk(v)
        elif isinstance(x,list):
            for v in x: walk(v)
    walk(s)
    for group, required in {
        'sources':['locator'], 'evidence':['source_ids','statement','kind','period','locator'],
        'metrics':['period','unit','basis','kind','value'],
        'theses':['statement','mechanism','assumption_ids','support_ids','counter_ids','alternatives','unknowns','confidence_reason'],
        'valuations':['method','as_of','assumption_ids','evidence_ids','formula_description','value','unit','limitations'],
        'monitoring':['thesis_ids','metric','source_ids','frequency','warning','invalidation','action','threshold_basis'],
    }.items():
        for row in s.get(group,[]) if isinstance(s.get(group),list) else []:
            if isinstance(row,dict):
                for key in required:
                    if key not in row: errors.append(f'{row.get("id",group)} missing {key}')
    def exists(p): return isinstance(p,str) and bool(p) and (base/Path(p)).is_file()
    if s.get('schema_version') == 2:
        has_workbook = ctx.get('has_workbook') if isinstance(ctx, dict) else None
        if type(has_workbook) is not bool: errors.append('context.has_workbook must be boolean')
        gate = s.get('model_understanding')
        if not isinstance(gate, dict):
            errors.append('Missing model_understanding gate A')
        else:
            status = gate.get('status')
            if status not in ('pending', 'pass', 'needs_revision', 'not_applicable'): errors.append('Invalid gate A status')
            if gate.get('scope') not in ('full', 'targeted'): errors.append('Invalid gate A scope')
            if gate.get('reviewer_mode') not in ('self', 'independent'): errors.append('Invalid gate A reviewer_mode')
            if status == 'not_applicable' and (has_workbook is not False or not gate.get('reason')):
                errors.append('Gate A not_applicable requires no workbook and a reason')
            if has_workbook is False and status != 'not_applicable': errors.append('No workbook: gate A must be not_applicable')
            checks = gate.get('checks')
            if not isinstance(checks, list): errors.append('Gate A checks must be an array')
            if status == 'pass':
                if not exists(gate.get('report_path')): errors.append('Gate A pass requires a model explanation file')
                rows = [r for r in checks if isinstance(r, dict)] if isinstance(checks, list) else []
                if len(rows) != 6 or {r.get('id') for r in rows} != {f'U{i}' for i in range(1, 7)}:
                    errors.append('Gate A pass requires U1-U6 acceptance records')
                if not any(r.get('status') == 'pass' for r in rows): errors.append('Gate A requires at least one verified check')
                for row in rows:
                    if row.get('status') not in ('pass', 'not_applicable') or not row.get('result') or not row.get('verification'):
                        errors.append(f'Gate A incomplete check: {row.get("id")}')
                    if row.get('status') == 'pass' and not row.get('evidence_ids'):
                        errors.append(f'Gate A check lacks evidence: {row.get("id")}')
            if s.get('stage') == 'reviewed_draft' and has_workbook is True:
                if status != 'pass' or gate.get('scope') != 'full': errors.append('reviewed_draft requires full gate A pass')
        review = s.get('review', {})
        investment_status = review.get('investment_status') if isinstance(review, dict) else None
        if investment_status not in ('pending', 'pass', 'needs_revision', 'not_requested'): errors.append('Invalid investment gate B status')
        if s.get('stage') == 'reviewed_draft' and investment_status != 'pass': errors.append('reviewed_draft requires gate B pass')
    checkpoint=s.get('case_checkpoint')
    if s.get('valuations') and s.get('stage') != 'partial':
        if not isinstance(checkpoint,dict) or not checkpoint.get('saved_at') or not exists(checkpoint.get('snapshot_path')):
            errors.append('Full valuation requires a saved case checkpoint file')
    for a in s.get('artifacts',[]) if isinstance(s.get('artifacts'),list) else []:
        if isinstance(a,dict) and not exists(a.get('path')): errors.append(f'Artifact not found: {a.get("id")}')
    if s.get('stage')=='reviewed_draft':
        review=s.get('review',{})
        if not isinstance(review,dict) or review.get('status')!='pass': errors.append('reviewed_draft requires review pass')
        if isinstance(review,dict):
            for item in review.get('findings',[]):
                if item.get('severity')=='blocker' and not item.get('resolved'): errors.append('Unresolved blocker')
    return errors

def self_test():
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        base=Path(tmp)
        s={k:[] for k in COLLECTIONS}
        s.update(schema_version=1,revision=1,stage='draft',context=dict(company='Test',objective='Review',cutoff='2026-09-20',currency='EUR'),business={},market={},review={'status':'pending'},case_checkpoint=None)
        assert validate(s,base)==[]
        s['business']={'evidence_ids':['missing']}
        assert any('Unresolved' in x for x in validate(s,base))
        s['business']={}
        s['valuations']=[dict(id='V1',method='PE',as_of='2026-09-20',assumption_ids=[],evidence_ids=[],formula_description='EPS × PE',value=None,unit='EUR/share',limitations=['Unavailable'])]
        assert any('checkpoint' in x for x in validate(s,base))
        (base/'case.json').write_text('{}')
        s['case_checkpoint']={'saved_at':'2026-09-20','snapshot_path':'case.json'}
        assert validate(s,base)==[]
        s['artifacts']=[{'id':'FIG1','path':'missing.png'}]
        assert any('Artifact' in x for x in validate(s,base))
        s['artifacts']=[];s['stage']='reviewed_draft';s['review']={'status':'pass','findings':[{'severity':'blocker','resolved':False}]}
        assert any('blocker' in x for x in validate(s,base))
        s.update(schema_version=2, stage='draft')
        s['context']['has_workbook']=True
        s['review']={'status':'pending','investment_status':'pending'}
        assert any('gate A' in x for x in validate(s,base))
        s['model_understanding']={'status':'pending','scope':'full','reviewer_mode':'self','checks':[]}
        assert validate(s,base)==[]
        s['stage']='reviewed_draft';s['review'].update(status='pass',investment_status='pass')
        assert any('gate A' in x for x in validate(s,base))
        s['model_understanding'].update(status='pass',report_path='case.json',checks=[])
        assert any('U1-U6' in x for x in validate(s,base))
        s['evidence']=[dict(id='E1',source_ids=[],statement='Test formula',kind='formula',period='2026',locator='Sheet A1')]
        s['model_understanding']['checks']=[dict(id=f'U{i}',status='pass',evidence_ids=['E1'],verification='Fixture path recomputed',result='Match') for i in range(1,7)]
        assert validate(s,base)==[]
        s['model_understanding']['checks'][4]['status']='unverified'
        assert any('incomplete' in x for x in validate(s,base))
        s['model_understanding']['checks'][4]['status']='pass'
        s['review']['investment_status']='pending'
        assert any('gate B' in x for x in validate(s,base))
        s['stage']='draft';s['context']['has_workbook']=False
        s['model_understanding'].update(status='not_applicable',reason='No workbook',checks=[])
        assert validate(s,base)==[]
    print('Self-test passed')

if __name__=='__main__':
    if len(sys.argv)==2 and sys.argv[1]=='--self-test': self_test()
    elif len(sys.argv)==2:
        p=Path(sys.argv[1]).resolve()
        try: errors=validate(json.loads(p.read_text()),p.parent)
        except (OSError,ValueError) as exc: errors=[str(exc)]
        print('\n'.join(errors) if errors else 'State structure valid; financial and evidence review still required. Version 1 does not certify the two acceptance gates.')
        sys.exit(bool(errors))
    else: sys.exit('Usage: validate_state.py STATE.json | --self-test')
