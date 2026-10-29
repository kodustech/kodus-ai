import json
d=json.load(open('opus-in1.json'))
keys=list(d)
R={
keys[0]:[("S1","#07",None,"Unguarded mainHostDestinationCalendar.integration throws when destinationCalendar is null/empty."),
 ("S2","#03",None,"Dead fallback: find compares externalId to the falsy externalCalendarId in updateEvent."),
 ("S3","#03",None,"Same dead destination-calendar fallback in deleteEvent."),
 ("S4","#08",None,"Optional push on null destinationCalendar drops collective hosts' calendars."),
 ("S5","#07",None,"Unguarded mainHostDestinationCalendar.integration crash on null/empty destinationCalendar."),
 ("S6","#03",None,"Dead find fallback in updateEvent never matches."),
 ("S7","#03",None,"Dead find fallback in deleteEvent never matches."),
 ("S8","#08",None,"Optional push no-op on null destinationCalendar drops team calendars."),
 ("S9","#08",None,"Optional push no-op on null destinationCalendar drops team calendars.")],
keys[1]:[("S1","#01",None,"Truthiness-based age/timestamp mutual exclusion lets zero values bypass the check."),
 ("S2","#06",None,"zip of error_ids with get_multi values misaligns error details."),
 ("S3","new","N1","Preprod assemble analytics recorded before the feature-flag check; no golden issue covers it."),
 ("S4","#01",None,"Truthiness-based mutual exclusion bypassed by zero values."),
 ("S5","#06",None,"get_multi drops missing ids so zip misaligns error ids and payloads."),
 ("S6","new","N1","Same preprod analytics-before-feature-gate problem.")],
keys[2]:[("S1","#01",None,"Duplicate downsize definition overrides the width/height version, breaking ResizeEmoji's call; same fix (remove duplicate) though the stated consequence differs."),
 ("S2","#02",None,"Client-side size check hardcodes 10MB instead of max_<type>_size_kb."),
 ("S3","#sncc-01",None,"413 handler error message shows hard-coded 10MB limit that may not match server limit."),
 ("S4","new","N1","Hardcoded 10MB download cap for URL uploads increases memory/temp work; no golden issue covers the download cap."),
 ("S5","#01",None,"Duplicate downsize definition makes ResizeEmoji call raise ArgumentError.")],
keys[3]:[("S1","#06",None,"Independently computed common prefix/suffix overlap and substring throws."),
 ("S2","new","N1","Email-file detection via absolute path contains('email') misfires; not in golden set."),
 ("S3","#01",None,"Lithuanian TOTP step replaced with Italian text."),
 ("S4","#06",None,"Overlapping prefix/suffix causes StringIndexOutOfBoundsException.")],
keys[4]:[("S1","#09",None,"metadata['sender']['login'] indexed without checking sender exists -> KeyError."),
 ("S2","new","N1","Missing positive-path test asserting the user/sender match; #10 is about the wrong state in test_installation_not_found, a different defect."),
 ("S3","new","N2","Token exchange omits redirect_uri; no golden issue covers it."),
 ("S4","new","N1","Same missing positive-path coverage of the sender-match check.")],
keys[5]:[("S1","#01",None,"No re-check of cache after acquiring write lock, redundant manifest reloads."),
 ("S2","#01",None,"Incomplete double-checked locking in GetWebAssets.")],
keys[6]:[("S1","#01",None,"BuildIndex locks only the final assignment so concurrent builds of the same key run and overwrite."),
 ("S2","#01",None,"Concurrent builds for the same key overwrite the cache entry.")],
keys[7]:[("S1","#03",None,"Base login-password.ftl lacks passkeys conditional UI while PasswordForm enables it."),
 ("S2","#03",None,"Base theme login-password.ftl lacks passkeys conditional UI.")],
keys[8]:[("S1","#01",None,"getAuthorizationConditions never returns falsy so getBaseConditions fallback branches are unreachable.")],
keys[9]:[("S1","#09",None,"TagDevice now synchronous in Authenticate, adding inline DB round-trips instead of fire-and-forget.")],
}
out={}
for k,lst in R.items():
    out[k]=[{"id":i,"match":(m if m=="new" else k+m),"newGroup":g,"reason":r} for i,m,g,r in lst]
json.dump(out,open('opus-out1.json','w'),indent=1,ensure_ascii=False)
for k,v in d.items():
    ids=[s['id'] for s in v['sugestoes']]; got=[x['id'] for x in out[k]]
    assert sorted(ids)==sorted(got) and len(set(got))==len(got),k
    iss={i['issueId'] for i in v['issues']}
    for x in out[k]: assert x['match']=='new' or x['match'] in iss,(k,x)
n=sum(x['match']=='new' for v in out.values() for x in v); t=sum(len(v) for v in out.values())
print('ok',t,'new',n,'matched',t-n)
