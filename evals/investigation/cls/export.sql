WITH s AS (
 SELECT suggestionId, organizationId org, repo_full_name repo, pullRequestId pr,
   LOWER(REPLACE(suggestionImplementationStatus,' ','_')) st,
   suggestionLabel label, suggestionSeverity severity, suggestionLanguage lang,
   SUBSTR(suggestionOneSentenceSummary,1,400) summary,
   SUBSTR(suggestionContent,1,2000) content,
   SUBSTR(suggestionExistingCode,1,1200) existing,
   SUBSTR(suggestionImprovedCode,1,1200) improved,
   SUBSTR(suggestionCreatedAt,1,10) day
 FROM `kody-408918.kodus_mongo.suggestions_mv`
 WHERE suggestionDeliveryStatus='sent'
   AND SAFE_CAST(suggestionCreatedAt AS TIMESTAMP) > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 365 DAY)
   AND suggestionLabel IN ('bug','security','performance','cross_file')
   AND suggestionContent IS NOT NULL),
f AS (SELECT suggestionId, MAX(SAFE_CAST(JSON_VALUE(reactions,'$.thumbsUp') AS INT64)) up,
        MAX(SAFE_CAST(JSON_VALUE(reactions,'$.thumbsDown') AS INT64)) down
      FROM `kody-408918.kodus_mongo.codeReviewFeedback` GROUP BY 1),
j AS (SELECT s.*, IFNULL(f.up,0) up, IFNULL(f.down,0) down FROM s LEFT JOIN f USING(suggestionId))
SELECT * FROM j
WHERE st IN ('implemented','partially_implemented')
   OR (st='not_implemented' AND down>0)
   OR (st='not_implemented' AND down=0 AND MOD(ABS(FARM_FINGERPRINT(suggestionId)),100) < 30)
