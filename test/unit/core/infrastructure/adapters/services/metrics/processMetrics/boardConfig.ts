const boardConfig = {
    "id": 5,
    "name": "quadro GE",
    "type": "simple",
    "self": "https://testevanni.atlassian.net/rest/agile/1.0/board/5/configuration",
    "location": {
        "type": "project",
        "key": "GE",
        "id": "10005",
        "self": "https://testevanni.atlassian.net/rest/api/2/project/10005",
        "name": "Gestão Escolar"
    },
    "filter": {
        "id": "10004",
        "self": "https://testevanni.atlassian.net/rest/api/2/filter/10004"
    },
    "columnConfig": {
        "columns": [
            {
                "name": "In Refinement",
                "statuses": [
                    {
                        "id": "10014",
                        "self": "https://testevanni.atlassian.net/rest/api/2/status/10014"
                    }
                ]
            },
            {
                "name": "READY TO DEV",
                "statuses": [
                    {
                        "id": "10015",
                        "self": "https://testevanni.atlassian.net/rest/api/2/status/10015"
                    }
                ]
            },
            {
                "name": "DOING",
                "statuses": [
                    {
                        "id": "10017",
                        "self": "https://testevanni.atlassian.net/rest/api/2/status/10017"
                    }
                ]
            },
            {
                "name": "READY TO CODE REVIEW",
                "statuses": [
                    {
                        "id": "10018",
                        "self": "https://testevanni.atlassian.net/rest/api/2/status/10018"
                    }
                ]
            },
            {
                "name": "IN CODE REVIEW",
                "statuses": [
                    {
                        "id": "10019",
                        "self": "https://testevanni.atlassian.net/rest/api/2/status/10019"
                    }
                ]
            },
            {
                "name": "READY TO QA",
                "statuses": [
                    {
                        "id": "10020",
                        "self": "https://testevanni.atlassian.net/rest/api/2/status/10020"
                    }
                ]
            },
            {
                "name": "IN QA",
                "statuses": [
                    {
                        "id": "10021",
                        "self": "https://testevanni.atlassian.net/rest/api/2/status/10021"
                    }
                ]
            },
            {
                "name": "READY TO DEPLOY",
                "statuses": [
                    {
                        "id": "10022",
                        "self": "https://testevanni.atlassian.net/rest/api/2/status/10022"
                    }
                ]
            },
            {
                "name": "DONE",
                "statuses": [
                    {
                        "id": "10016",
                        "self": "https://testevanni.atlassian.net/rest/api/2/status/10016"
                    }
                ]
            }
        ],
        "constraintType": "none"
    },
    "ranking": {
        "rankCustomFieldId": 10019
    }
}

module.exports = boardConfig;
