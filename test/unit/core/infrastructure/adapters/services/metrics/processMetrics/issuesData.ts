const issuesData = [
    {
        "columnName": "In Refinement",
        "issues": [
        ]
    },
    {
        "columnName": "READY TO DEV",
        "issues": [
        ]
    },
    {
        "columnName": "DOING",
        "issues": [
        ]
    },
    {
        "columnName": "IN CODE REVIEW",
        "issues": [
        ]
    },
    {
        "columnName": "READY TO CODE REVIEW",
        "issues": [
        ]
    },
    {
        "columnName": "READY TO QA",
        "issues": [
        ]
    },
    {
        "columnName": "READY TO DEPLOY",
        "issues": [
        ]
    },
    {
        "columnName": "IN QA",
        "issues": [
        ]
    },
    {
        "columnName": "Concluído",
        "issues": [
            {
                "id": "10049",
                "key": "GE-20",
                "name": "Campos de Data de Nascimento Aceitam Datas Futuras",
                "desc": [
                    {
                        "type": "paragraph",
                        "content": "O campo \"Data de Nascimento\" no formulário de cadastro de alunos permite que o usuário insira datas futuras, o que é logicamente incorreto e pode levar a registros inválidos."
                    },
                    {
                        "type": "paragraph",
                        "content": "Passos para reproduzir:"
                    },
                    {
                        "type": "orderedList",
                        "content": [
                            "1. Acesse a página de cadastro de alunos.",
                            "2. No campo \"Data de Nascimento\", insira uma data futura (ex: 01/01/2030).",
                            "3. Tente salvar o cadastro."
                        ]
                    },
                    {
                        "type": "paragraph",
                        "content": "Resultado esperado:"
                    },
                    {
                        "type": "paragraph",
                        "content": " O sistema deve validar o campo e exibir uma mensagem informando que a data de nascimento não pode ser no futuro."
                    },
                    {
                        "type": "paragraph",
                        "content": "Resultado obtido:"
                    },
                    {
                        "type": "paragraph",
                        "content": " O sistema aceita a data futura e permite que o cadastro seja salvo."
                    },
                    {
                        "type": "paragraph",
                        "content": "Observação:"
                    },
                    {
                        "type": "paragraph",
                        "content": " Esse tipo de bug pode levar a problemas em relatórios ou análises que dependam da idade ou ano de nascimento dos alunos. Validar datas de entrada é crucial para garantir a integridade dos dados."
                    }
                ],
                "changelog": [
                    {
                        "id": "10652",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-19T17:19:19.891-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked lower"
                            }
                        ]
                    },
                    {
                        "id": "10651",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-19T17:19:19.608-0300",
                        "items": [
                            {
                                "field": "resolution",
                                "fieldtype": "jira",
                                "fieldId": "resolution",
                                "from": null,
                                "fromString": null,
                                "to": "10000",
                                "toString": "Done"
                            },
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10022",
                                "fromString": "READY TO DEPLOY",
                                "to": "10016",
                                "toString": "DONE"
                            }
                        ]
                    },
                    {
                        "id": "10610",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-18T13:47:12.810-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10609",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-18T13:47:12.514-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10021",
                                "fromString": "IN QA",
                                "to": "10022",
                                "toString": "READY TO DEPLOY"
                            }
                        ]
                    },
                    {
                        "id": "10570",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-15T14:23:24.982-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10020",
                                "fromString": "READY TO QA",
                                "to": "10021",
                                "toString": "IN QA"
                            }
                        ]
                    },
                    {
                        "id": "10538",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-14T09:53:46.266-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10537",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-14T09:53:45.963-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10019",
                                "fromString": "IN CODE REVIEW",
                                "to": "10020",
                                "toString": "READY TO QA"
                            }
                        ]
                    },
                    {
                        "id": "10516",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-12T11:41:06.579-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10018",
                                "fromString": "READY TO CODE REVIEW",
                                "to": "10019",
                                "toString": "IN CODE REVIEW"
                            }
                        ]
                    },
                    {
                        "id": "10464",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T08:15:25.177-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10463",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T08:15:24.866-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10017",
                                "fromString": "DOING",
                                "to": "10018",
                                "toString": "READY TO CODE REVIEW"
                            }
                        ]
                    },
                    {
                        "id": "10325",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T11:26:39.006-0300",
                        "items": [
                            {
                                "field": "assignee",
                                "fieldtype": "jira",
                                "fieldId": "assignee",
                                "from": null,
                                "fromString": null,
                                "to": "628b7a0f1c97b5006f0a7ffe",
                                "toString": "Lucas Vanni",
                                "tmpFromAccountId": null,
                                "tmpToAccountId": "628b7a0f1c97b5006f0a7ffe"
                            }
                        ]
                    },
                    {
                        "id": "10324",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T11:26:32.879-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10323",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T11:26:32.594-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10015",
                                "fromString": "READY TO DEV",
                                "to": "10017",
                                "toString": "DOING"
                            }
                        ]
                    },
                    {
                        "id": "10288",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:33:42.660-0300",
                        "items": [
                            {
                                "field": "description",
                                "fieldtype": "jira",
                                "fieldId": "description",
                                "from": null,
                                "fromString": null,
                                "to": null,
                                "toString": "O campo \"Data de Nascimento\" no formulário de cadastro de alunos permite que o usuário insira datas futuras, o que é logicamente incorreto e pode levar a registros inválidos.\n\n*Passos para reproduzir:*\n\n# Acesse a página de cadastro de alunos.\n# No campo \"Data de Nascimento\", insira uma data futura (ex: 01/01/2030).\n# Tente salvar o cadastro.\n\n*Resultado esperado:* O sistema deve validar o campo e exibir uma mensagem informando que a data de nascimento não pode ser no futuro.\n\n*Resultado obtido:* O sistema aceita a data futura e permite que o cadastro seja salvo.\n\n*Observação:* Esse tipo de bug pode levar a problemas em relatórios ou análises que dependam da idade ou ano de nascimento dos alunos. Validar datas de entrada é crucial para garantir a integridade dos dados."
                            }
                        ]
                    },
                    {
                        "id": "10287",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:33:21.206-0300",
                        "items": [
                            {
                                "field": "assignee",
                                "fieldtype": "jira",
                                "fieldId": "assignee",
                                "from": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                                "fromString": "Junior Sartori",
                                "to": null,
                                "toString": null
                            }
                        ]
                    },
                    {
                        "id": "10284",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:33:06.170-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10014",
                                "fromString": "In Refinement",
                                "to": "10015",
                                "toString": "READY TO DEV"
                            }
                        ]
                    }
                ],
                "movement": [
                    "In Refinement: ",
                    "READY TO DEV: 3d 53m 26s",
                    "DOING: 2d 20h 48m 53s",
                    "READY TO CODE REVIEW: 1d 3h 17m 41s",
                    "IN CODE REVIEW: 1d 22h 20m 40s",
                    "READY TO QA: 1d 4h 29m 39s",
                    "IN QA: 2d 23h 23m 47s",
                    "READY TO DEPLOY: 1d 3h 32m 7s"
                ],
                "issueCreatedAt": "2023-09-05T10:33:05.682-0300",
                "columnName": "Concluído",
                "url": "https://testevanni.atlassian.net/browse/GE-20",
                "updated": "2023-09-19T17:19:19.881-0300",
                "created": "2023-09-05T10:33:05.682-0300",
                "lastViewed": null,
                "issueType": {
                    "name": "Erro",
                    "id": "10014",
                    "description": "Erros rastreiam problemas ou erros.",
                    "subtask": false
                },
                "project": {
                    "id": "10005",
                    "key": "GE",
                    "name": "Gestão Escolar",
                    "projectTypeKey": "software"
                },
                "priority": {
                    "name": "Medium",
                    "id": "3",
                    "iconUrl": "https://testevanni.atlassian.net/images/icons/priorities/medium.svg"
                },
                "assignee": {
                    "accountId": "628b7a0f1c97b5006f0a7ffe",
                    "emailAddress": "lucas.vanni@ezdevs.tech",
                    "displayName": "Lucas Vanni",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/c873f1b1a2fdd7ddf47890a86a954c50?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FLV-0.png",
                        "24x24": "https://secure.gravatar.com/avatar/c873f1b1a2fdd7ddf47890a86a954c50?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FLV-0.png",
                        "16x16": "https://secure.gravatar.com/avatar/c873f1b1a2fdd7ddf47890a86a954c50?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FLV-0.png",
                        "32x32": "https://secure.gravatar.com/avatar/c873f1b1a2fdd7ddf47890a86a954c50?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FLV-0.png"
                    }
                },
                "status": {
                    "name": "Concluído",
                    "id": "10016",
                    "statusCategory": {
                        "name": "Itens concluídos",
                        "id": 3
                    }
                },
                "creator": {
                    "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                    "displayName": "Junior Sartori",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                    }
                },
                "reporter": {
                    "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                    "displayName": "Junior Sartori",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                    }
                },
                "comment": {
                    "comments": [],
                    "total": 0,
                    "startAt": 0
                },
                "subtasks": []
            },
            {
                "id": "10048",
                "key": "GE-19",
                "name": "Erro ao Salvar Informações no Cadastro de Alunos",
                "desc": [
                    {
                        "type": "paragraph",
                        "content": "Ao tentar salvar um novo cadastro de aluno, o sistema retorna uma mensagem de erro genérica e não completa o processo de registro, deixando o perfil do aluno incompleto."
                    },
                    {
                        "type": "paragraph",
                        "content": "Passos para reproduzir:"
                    },
                    {
                        "type": "orderedList",
                        "content": [
                            "1. Acesse a página de cadastro de alunos.",
                            "2. Preencha todos os campos necessários para registrar um novo aluno.",
                            "3. Clique no botão \"Salvar\" ou \"Registrar\".",
                            "4. Observe a mensagem de erro apresentada."
                        ]
                    },
                    {
                        "type": "paragraph",
                        "content": "Resultado esperado:"
                    },
                    {
                        "type": "paragraph",
                        "content": " O cadastro do aluno deve ser salvo corretamente, e o sistema deve redirecionar o usuário para uma confirmação ou para a lista geral de alunos."
                    },
                    {
                        "type": "paragraph",
                        "content": "Resultado obtido:"
                    },
                    {
                        "type": "paragraph",
                        "content": " Mensagem de erro genérica é mostrada e o cadastro do aluno não é salvo."
                    }
                ],
                "changelog": [
                    {
                        "id": "10505",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T16:54:54.869-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10504",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T16:54:54.248-0300",
                        "items": [
                            {
                                "field": "resolution",
                                "fieldtype": "jira",
                                "fieldId": "resolution",
                                "from": null,
                                "fromString": null,
                                "to": "10000",
                                "toString": "Done"
                            },
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10022",
                                "fromString": "READY TO DEPLOY",
                                "to": "10016",
                                "toString": "DONE"
                            }
                        ]
                    },
                    {
                        "id": "10427",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T15:57:31.290-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked lower"
                            }
                        ]
                    },
                    {
                        "id": "10426",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T15:57:30.895-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10021",
                                "fromString": "IN QA",
                                "to": "10022",
                                "toString": "READY TO DEPLOY"
                            }
                        ]
                    },
                    {
                        "id": "10332",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T11:27:04.931-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10020",
                                "fromString": "READY TO QA",
                                "to": "10021",
                                "toString": "IN QA"
                            }
                        ]
                    },
                    {
                        "id": "10331",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T11:27:03.167-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10019",
                                "fromString": "IN CODE REVIEW",
                                "to": "10020",
                                "toString": "READY TO QA"
                            }
                        ]
                    },
                    {
                        "id": "10312",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T11:25:46.695-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10017",
                                "fromString": "DOING",
                                "to": "10019",
                                "toString": "IN CODE REVIEW"
                            }
                        ]
                    },
                    {
                        "id": "10293",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:38:54.739-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10292",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:38:54.430-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10015",
                                "fromString": "READY TO DEV",
                                "to": "10017",
                                "toString": "DOING"
                            }
                        ]
                    },
                    {
                        "id": "10291",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:38:52.303-0300",
                        "items": [
                            {
                                "field": "assignee",
                                "fieldtype": "jira",
                                "fieldId": "assignee",
                                "from": null,
                                "fromString": null,
                                "to": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                                "toString": "Junior Sartori",
                                "tmpFromAccountId": null,
                                "tmpToAccountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078"
                            }
                        ]
                    },
                    {
                        "id": "10285",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:33:10.858-0300",
                        "items": [
                            {
                                "field": "assignee",
                                "fieldtype": "jira",
                                "fieldId": "assignee",
                                "from": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                                "fromString": "Junior Sartori",
                                "to": null,
                                "toString": null
                            }
                        ]
                    },
                    {
                        "id": "10282",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:32:53.190-0300",
                        "items": [
                            {
                                "field": "description",
                                "fieldtype": "jira",
                                "fieldId": "description",
                                "from": null,
                                "fromString": null,
                                "to": null,
                                "toString": "Ao tentar salvar um novo cadastro de aluno, o sistema retorna uma mensagem de erro genérica e não completa o processo de registro, deixando o perfil do aluno incompleto.\n\n*Passos para reproduzir:*\n\n# Acesse a página de cadastro de alunos.\n# Preencha todos os campos necessários para registrar um novo aluno.\n# Clique no botão \"Salvar\" ou \"Registrar\".\n# Observe a mensagem de erro apresentada.\n\n*Resultado esperado:* O cadastro do aluno deve ser salvo corretamente, e o sistema deve redirecionar o usuário para uma confirmação ou para a lista geral de alunos.\n\n*Resultado obtido:* Mensagem de erro genérica é mostrada e o cadastro do aluno não é salvo."
                            }
                        ]
                    },
                    {
                        "id": "10281",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:32:25.330-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10014",
                                "fromString": "In Refinement",
                                "to": "10015",
                                "toString": "READY TO DEV"
                            }
                        ]
                    }
                ],
                "movement": [
                    "In Refinement: ",
                    "READY TO DEV: 6m 29s",
                    "DOING: 3d 46m 52s",
                    "IN CODE REVIEW: 1m 17s",
                    "READY TO QA: 2s",
                    "IN QA: 4h 30m 26s",
                    "READY TO DEPLOY: 3d 57m 23s"
                ],
                "issueCreatedAt": "2023-09-05T10:32:24.848-0300",
                "columnName": "Concluído",
                "url": "https://testevanni.atlassian.net/browse/GE-19",
                "updated": "2023-09-11T16:54:54.859-0300",
                "created": "2023-09-05T10:32:24.848-0300",
                "lastViewed": null,
                "issueType": {
                    "name": "Erro",
                    "id": "10014",
                    "description": "Erros rastreiam problemas ou erros.",
                    "subtask": false
                },
                "project": {
                    "id": "10005",
                    "key": "GE",
                    "name": "Gestão Escolar",
                    "projectTypeKey": "software"
                },
                "priority": {
                    "name": "Medium",
                    "id": "3",
                    "iconUrl": "https://testevanni.atlassian.net/images/icons/priorities/medium.svg"
                },
                "assignee": {
                    "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                    "displayName": "Junior Sartori",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                    }
                },
                "status": {
                    "name": "Concluído",
                    "id": "10016",
                    "statusCategory": {
                        "name": "Itens concluídos",
                        "id": 3
                    }
                },
                "creator": {
                    "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                    "displayName": "Junior Sartori",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                    }
                },
                "reporter": {
                    "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                    "displayName": "Junior Sartori",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                    }
                },
                "comment": {
                    "comments": [],
                    "total": 0,
                    "startAt": 0
                },
                "subtasks": []
            },
            {
                "id": "10047",
                "key": "GE-18",
                "name": "Relatório Integrado de Turmas, Professores e Matérias",
                "desc": [
                    {
                        "type": "paragraph",
                        "content": "Desenvolver uma funcionalidade de relatório que consolide e apresente informações inter-relacionadas sobre turmas, professores e matérias. Este relatório tem como objetivo fornecer aos administradores e gestores uma visão clara das relações entre turmas, os professores designados para elas e as matérias lecionadas."
                    },
                    {
                        "type": "paragraph",
                        "content": "Critérios de Aceite:"
                    },
                    {
                        "type": "orderedList",
                        "content": [
                            "1. O sistema deve fornecer uma página ou seção dedicada para visualizar o relatório.",
                            "2. Os usuários podem filtrar o relatório por série/ano, nome da turma, professores ou matérias.",
                            "3. O relatório deve exibir, para cada turma: nome da turma, série/ano, lista de professores associados e matérias que são lecionadas.",
                            "4. Cada entrada de professor deve ser clicável, levando a um perfil detalhado do professor.",
                            "5. Cada entrada de matéria também deve ser clicável, levando a um detalhamento da matéria.",
                            "6. O relatório deve oferecer opções de exportação, como PDF ou CSV.",
                            "7. A interface do relatório deve ser clara, responsiva e fácil de navegar."
                        ]
                    },
                    {
                        "type": "paragraph",
                        "content": "Definição de Pronto:"
                    },
                    {
                        "type": "bulletList",
                        "content": [
                            {
                                "title": "A funcionalidade de relatório integrado foi desenvolvida e cumpre todos os critérios de aceite."
                            },
                            {
                                "title": "A funcionalidade passou por testes extensivos para garantir precisão e eficiência na apresentação dos dados."
                            },
                            {
                                "title": "O código foi revisado por pelo menos outro membro da equipe de desenvolvimento e não contém falhas críticas."
                            },
                            {
                                "title": "A documentação relevante para esta funcionalidade foi elaborada ou atualizada."
                            }
                        ]
                    },
                    {
                        "type": "paragraph",
                        "content": "Observação:"
                    },
                    {
                        "type": "paragraph",
                        "content": " Esta funcionalidade é essencial para a tomada de decisões e para uma visão geral do funcionamento da instituição, garantindo que os recursos (professores e matérias) sejam distribuídos de forma eficiente entre as turmas. Além disso, a capacidade de exportar os dados permite que os gestores compartilhem informações facilmente com outras partes interessadas ou usem os dados para análises externas."
                    }
                ],
                "changelog": [
                    {
                        "id": "10601",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-18T13:46:50.175-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked lower"
                            }
                        ]
                    },
                    {
                        "id": "10600",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-18T13:46:49.897-0300",
                        "items": [
                            {
                                "field": "resolution",
                                "fieldtype": "jira",
                                "fieldId": "resolution",
                                "from": null,
                                "fromString": null,
                                "to": "10000",
                                "toString": "Done"
                            },
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10022",
                                "fromString": "READY TO DEPLOY",
                                "to": "10016",
                                "toString": "DONE"
                            }
                        ]
                    },
                    {
                        "id": "10565",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-15T14:23:09.044-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10564",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-15T14:23:08.725-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10021",
                                "fromString": "IN QA",
                                "to": "10022",
                                "toString": "READY TO DEPLOY"
                            }
                        ]
                    },
                    {
                        "id": "10536",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-14T09:53:44.336-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10535",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-14T09:53:43.957-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10020",
                                "fromString": "READY TO QA",
                                "to": "10021",
                                "toString": "IN QA"
                            }
                        ]
                    },
                    {
                        "id": "10509",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-12T11:40:53.587-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10508",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-12T11:40:53.277-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10019",
                                "fromString": "IN CODE REVIEW",
                                "to": "10020",
                                "toString": "READY TO QA"
                            }
                        ]
                    },
                    {
                        "id": "10494",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T16:53:22.415-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10493",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T16:53:22.065-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10018",
                                "fromString": "READY TO CODE REVIEW",
                                "to": "10019",
                                "toString": "IN CODE REVIEW"
                            }
                        ]
                    },
                    {
                        "id": "10462",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T08:15:21.120-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10461",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T08:15:20.804-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10017",
                                "fromString": "DOING",
                                "to": "10018",
                                "toString": "READY TO CODE REVIEW"
                            }
                        ]
                    },
                    {
                        "id": "10322",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T11:26:28.049-0300",
                        "items": [
                            {
                                "field": "assignee",
                                "fieldtype": "jira",
                                "fieldId": "assignee",
                                "from": null,
                                "fromString": null,
                                "to": "712020:ba315faf-0618-4ba0-ac94-fdb47d3240d4",
                                "toString": "Beatriz Ereno",
                                "tmpFromAccountId": null,
                                "tmpToAccountId": "712020:ba315faf-0618-4ba0-ac94-fdb47d3240d4"
                            }
                        ]
                    },
                    {
                        "id": "10321",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T11:26:21.151-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10320",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T11:26:20.803-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10015",
                                "fromString": "READY TO DEV",
                                "to": "10017",
                                "toString": "DOING"
                            }
                        ]
                    },
                    {
                        "id": "10286",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:33:17.506-0300",
                        "items": [
                            {
                                "field": "assignee",
                                "fieldtype": "jira",
                                "fieldId": "assignee",
                                "from": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                                "fromString": "Junior Sartori",
                                "to": null,
                                "toString": null
                            }
                        ]
                    },
                    {
                        "id": "10277",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:28:37.171-0300",
                        "items": [
                            {
                                "field": "description",
                                "fieldtype": "jira",
                                "fieldId": "description",
                                "from": null,
                                "fromString": null,
                                "to": null,
                                "toString": "Desenvolver uma funcionalidade de relatório que consolide e apresente informações inter-relacionadas sobre turmas, professores e matérias. Este relatório tem como objetivo fornecer aos administradores e gestores uma visão clara das relações entre turmas, os professores designados para elas e as matérias lecionadas.\n\n*Critérios de Aceite:*\n\n# O sistema deve fornecer uma página ou seção dedicada para visualizar o relatório.\n# Os usuários podem filtrar o relatório por série/ano, nome da turma, professores ou matérias.\n# O relatório deve exibir, para cada turma: nome da turma, série/ano, lista de professores associados e matérias que são lecionadas.\n# Cada entrada de professor deve ser clicável, levando a um perfil detalhado do professor.\n# Cada entrada de matéria também deve ser clicável, levando a um detalhamento da matéria.\n# O relatório deve oferecer opções de exportação, como PDF ou CSV.\n# A interface do relatório deve ser clara, responsiva e fácil de navegar.\n\n*Definição de Pronto:*\n\n* A funcionalidade de relatório integrado foi desenvolvida e cumpre todos os critérios de aceite.\n* A funcionalidade passou por testes extensivos para garantir precisão e eficiência na apresentação dos dados.\n* O código foi revisado por pelo menos outro membro da equipe de desenvolvimento e não contém falhas críticas.\n* A documentação relevante para esta funcionalidade foi elaborada ou atualizada.\n\n*Observação:* Esta funcionalidade é essencial para a tomada de decisões e para uma visão geral do funcionamento da instituição, garantindo que os recursos (professores e matérias) sejam distribuídos de forma eficiente entre as turmas. Além disso, a capacidade de exportar os dados permite que os gestores compartilhem informações facilmente com outras partes interessadas ou usem os dados para análises externas."
                            }
                        ]
                    },
                    {
                        "id": "10276",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:27:56.881-0300",
                        "items": [
                            {
                                "field": "summary",
                                "fieldtype": "jira",
                                "fieldId": "summary",
                                "from": null,
                                "fromString": "Relatório Integrado de Turmas, Professores e Matérias Descrição:",
                                "to": null,
                                "toString": "Relatório Integrado de Turmas, Professores e Matérias"
                            }
                        ]
                    },
                    {
                        "id": "10275",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:27:50.874-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10014",
                                "fromString": "In Refinement",
                                "to": "10015",
                                "toString": "READY TO DEV"
                            }
                        ]
                    }
                ],
                "movement": [
                    "In Refinement: ",
                    "READY TO DEV: 3d 58m 30s",
                    "DOING: 2d 20h 49m",
                    "READY TO CODE REVIEW: 8h 38m 1s",
                    "IN CODE REVIEW: 18h 47m 31s",
                    "READY TO QA: 1d 22h 12m 51s",
                    "IN QA: 1d 4h 29m 25s",
                    "READY TO DEPLOY: 2d 23h 23m 41s"
                ],
                "issueCreatedAt": "2023-09-05T10:27:50.403-0300",
                "columnName": "Concluído",
                "url": "https://testevanni.atlassian.net/browse/GE-18",
                "updated": "2023-09-18T13:46:50.169-0300",
                "created": "2023-09-05T10:27:50.403-0300",
                "lastViewed": null,
                "issueType": {
                    "name": "Tarefa",
                    "id": "10011",
                    "description": "Uma parte pequena e distinta do trabalho.",
                    "subtask": false
                },
                "project": {
                    "id": "10005",
                    "key": "GE",
                    "name": "Gestão Escolar",
                    "projectTypeKey": "software"
                },
                "priority": {
                    "name": "Medium",
                    "id": "3",
                    "iconUrl": "https://testevanni.atlassian.net/images/icons/priorities/medium.svg"
                },
                "assignee": {
                    "accountId": "712020:ba315faf-0618-4ba0-ac94-fdb47d3240d4",
                    "emailAddress": "beatriz.ereno@kodus.io",
                    "displayName": "Beatriz Ereno",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/284828fe3eabaf22596679cf0e088bd9?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FBE-1.png",
                        "24x24": "https://secure.gravatar.com/avatar/284828fe3eabaf22596679cf0e088bd9?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FBE-1.png",
                        "16x16": "https://secure.gravatar.com/avatar/284828fe3eabaf22596679cf0e088bd9?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FBE-1.png",
                        "32x32": "https://secure.gravatar.com/avatar/284828fe3eabaf22596679cf0e088bd9?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FBE-1.png"
                    }
                },
                "status": {
                    "name": "Concluído",
                    "id": "10016",
                    "statusCategory": {
                        "name": "Itens concluídos",
                        "id": 3
                    }
                },
                "creator": {
                    "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                    "displayName": "Junior Sartori",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                    }
                },
                "reporter": {
                    "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                    "displayName": "Junior Sartori",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                    }
                },
                "comment": {
                    "comments": [],
                    "total": 0,
                    "startAt": 0
                },
                "subtasks": []
            },
            {
                "id": "10022",
                "key": "GE-5",
                "name": "Listagem de Alunos",
                "desc": [
                    {
                        "type": "paragraph",
                        "content": "Desenvolver uma página de listagem de alunos, organizada por turma ou ordem alfabética, para que os professores possam visualizar rapidamente todos os alunos de uma turma específica ou da escola como um todo."
                    }
                ],
                "changelog": [
                    {
                        "id": "10650",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-19T17:19:16.950-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked lower"
                            }
                        ]
                    },
                    {
                        "id": "10649",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-19T17:19:16.458-0300",
                        "items": [
                            {
                                "field": "resolution",
                                "fieldtype": "jira",
                                "fieldId": "resolution",
                                "from": null,
                                "fromString": null,
                                "to": "10000",
                                "toString": "Done"
                            },
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10022",
                                "fromString": "READY TO DEPLOY",
                                "to": "10016",
                                "toString": "DONE"
                            }
                        ]
                    },
                    {
                        "id": "10608",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-18T13:47:10.279-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10021",
                                "fromString": "IN QA",
                                "to": "10022",
                                "toString": "READY TO DEPLOY"
                            }
                        ]
                    },
                    {
                        "id": "10572",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-15T14:23:26.563-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10571",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-15T14:23:26.254-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10020",
                                "fromString": "READY TO QA",
                                "to": "10021",
                                "toString": "IN QA"
                            }
                        ]
                    },
                    {
                        "id": "10486",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T16:52:53.441-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10019",
                                "fromString": "IN CODE REVIEW",
                                "to": "10020",
                                "toString": "READY TO QA"
                            }
                        ]
                    },
                    {
                        "id": "10456",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T08:14:53.034-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10018",
                                "fromString": "READY TO CODE REVIEW",
                                "to": "10019",
                                "toString": "IN CODE REVIEW"
                            }
                        ]
                    },
                    {
                        "id": "10314",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T11:25:50.770-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10313",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T11:25:50.137-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10017",
                                "fromString": "DOING",
                                "to": "10018",
                                "toString": "READY TO CODE REVIEW"
                            }
                        ]
                    },
                    {
                        "id": "10203",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T09:49:08.303-0300",
                        "items": [
                            {
                                "field": "assignee",
                                "fieldtype": "jira",
                                "fieldId": "assignee",
                                "from": null,
                                "fromString": null,
                                "to": "5aea4ab19cfeaf198aeeaf78",
                                "toString": "Wellington Santana",
                                "tmpFromAccountId": null,
                                "tmpToAccountId": "5aea4ab19cfeaf198aeeaf78"
                            }
                        ]
                    },
                    {
                        "id": "10202",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T09:49:04.557-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked lower"
                            }
                        ]
                    },
                    {
                        "id": "10201",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T09:49:04.218-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10015",
                                "fromString": "READY TO DEV",
                                "to": "10017",
                                "toString": "DOING"
                            }
                        ]
                    },
                    {
                        "id": "10092",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-08-22T14:44:05.283-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10091",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-08-22T14:44:05.033-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10014",
                                "fromString": "In Refinement",
                                "to": "10015",
                                "toString": "READY TO DEV"
                            }
                        ]
                    },
                    {
                        "id": "10090",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-08-22T14:43:55.688-0300",
                        "items": [
                            {
                                "field": "description",
                                "fieldtype": "jira",
                                "fieldId": "description",
                                "from": null,
                                "fromString": null,
                                "to": null,
                                "toString": "Desenvolver uma página de listagem de alunos, organizada por turma ou ordem alfabética, para que os professores possam visualizar rapidamente todos os alunos de uma turma específica ou da escola como um todo."
                            }
                        ]
                    }
                ],
                "movement": [
                    "In Refinement: 4m 28s",
                    "READY TO DEV: 13d 19h 4m 59s",
                    "DOING: 3d 1h 36m 46s",
                    "READY TO CODE REVIEW: 2d 20h 49m 3s",
                    "IN CODE REVIEW: 8h 38m",
                    "READY TO QA: 3d 21h 30m 33s",
                    "IN QA: 2d 23h 23m 44s",
                    "READY TO DEPLOY: 1d 3h 32m 6s"
                ],
                "issueCreatedAt": "2023-08-22T14:39:36.606-0300",
                "columnName": "Concluído",
                "url": "https://testevanni.atlassian.net/browse/GE-5",
                "updated": "2023-09-19T17:19:16.941-0300",
                "created": "2023-08-22T14:39:36.606-0300",
                "lastViewed": null,
                "issueType": {
                    "name": "Tarefa",
                    "id": "10011",
                    "description": "Uma parte pequena e distinta do trabalho.",
                    "subtask": false
                },
                "project": {
                    "id": "10005",
                    "key": "GE",
                    "name": "Gestão Escolar",
                    "projectTypeKey": "software"
                },
                "priority": {
                    "name": "Medium",
                    "id": "3",
                    "iconUrl": "https://testevanni.atlassian.net/images/icons/priorities/medium.svg"
                },
                "assignee": {
                    "accountId": "5aea4ab19cfeaf198aeeaf78",
                    "emailAddress": "wellington.santana@kodus.io",
                    "displayName": "Wellington Santana",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/5aea4ab19cfeaf198aeeaf78/ca3ee8a2-8990-4fa2-81b9-a8f7087fbe40/48",
                        "24x24": "https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/5aea4ab19cfeaf198aeeaf78/ca3ee8a2-8990-4fa2-81b9-a8f7087fbe40/24",
                        "16x16": "https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/5aea4ab19cfeaf198aeeaf78/ca3ee8a2-8990-4fa2-81b9-a8f7087fbe40/16",
                        "32x32": "https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/5aea4ab19cfeaf198aeeaf78/ca3ee8a2-8990-4fa2-81b9-a8f7087fbe40/32"
                    }
                },
                "status": {
                    "name": "Concluído",
                    "id": "10016",
                    "statusCategory": {
                        "name": "Itens concluídos",
                        "id": 3
                    }
                },
                "creator": {
                    "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                    "displayName": "Junior Sartori",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                    }
                },
                "reporter": {
                    "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                    "displayName": "Junior Sartori",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                    }
                },
                "comment": {
                    "comments": [],
                    "total": 0,
                    "startAt": 0
                },
                "subtasks": []
            },
            {
                "id": "10021",
                "key": "GE-4",
                "name": "Vinculação de alunos a turmas",
                "desc": [
                    {
                        "type": "paragraph",
                        "content": "Desenvolver um módulo robusto para o cadastro de alunos e posterior vinculação desses alunos a turmas específicas. O sistema deve permitir que usuários administrativos possam inserir detalhes do aluno (como nome, data de nascimento, etc.) e, após o cadastro, vincular esse aluno a uma ou mais turmas."
                    },
                    {
                        "type": "paragraph",
                        "content": "Critérios de Aceite:"
                    },
                    {
                        "type": "orderedList",
                        "content": [
                            "1. O sistema deve permitir inserir detalhes do aluno, como: nome, data de nascimento, endereço, etc.",
                            "2. O sistema deve verificar se um aluno com as mesmas informações não está duplicado.",
                            "3. Após o cadastro do aluno, deve ser possível vinculá-lo a uma ou mais turmas.",
                            "4. O sistema deve verificar se a turma à qual o aluno está sendo vinculado ainda possui vagas.",
                            "5. Deve ser possível editar as informações de um aluno já cadastrado.",
                            "6. Deve ser possível remover um aluno (considerando remoção lógica).",
                            "7. Ao visualizar uma turma, deve-se listar todos os alunos vinculados a ela.",
                            "8. Ao remover um aluno de uma turma, o sistema deve atualizar o número de vagas disponíveis naquela turma."
                        ]
                    },
                    {
                        "type": "paragraph",
                        "content": "Definição de Pronto:"
                    },
                    {
                        "type": "bulletList",
                        "content": [
                            {
                                "title": "A funcionalidade está desenvolvida conforme os critérios de aceite."
                            },
                            {
                                "title": "A funcionalidade passou por testes manuais e automáticos, garantindo que todos os cenários, inclusive de erro, foram testados."
                            },
                            {
                                "title": "O código foi revisado e não possui bugs ou vulnerabilidades críticas."
                            },
                            {
                                "title": "A documentação relacionada à funcionalidade foi atualizada."
                            },
                            {
                                "title": "O módulo foi testado em diferentes dispositivos e navegadores para garantir a compatibilidade."
                            },
                            {
                                "title": "Feedback dos stakeholders foi coletado e considerado durante o desenvolvimento."
                            }
                        ]
                    }
                ],
                "changelog": [
                    {
                        "id": "10597",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-18T13:46:45.356-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked lower"
                            }
                        ]
                    },
                    {
                        "id": "10596",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-18T13:46:44.978-0300",
                        "items": [
                            {
                                "field": "resolution",
                                "fieldtype": "jira",
                                "fieldId": "resolution",
                                "from": null,
                                "fromString": null,
                                "to": "10000",
                                "toString": "Done"
                            },
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10022",
                                "fromString": "READY TO DEPLOY",
                                "to": "10016",
                                "toString": "DONE"
                            }
                        ]
                    },
                    {
                        "id": "10569",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-15T14:23:12.495-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10568",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-15T14:23:12.080-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10021",
                                "fromString": "IN QA",
                                "to": "10022",
                                "toString": "READY TO DEPLOY"
                            }
                        ]
                    },
                    {
                        "id": "10532",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-14T09:53:36.214-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10020",
                                "fromString": "READY TO QA",
                                "to": "10021",
                                "toString": "IN QA"
                            }
                        ]
                    },
                    {
                        "id": "10513",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-12T11:40:59.975-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10512",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-12T11:40:59.655-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10019",
                                "fromString": "IN CODE REVIEW",
                                "to": "10020",
                                "toString": "READY TO QA"
                            }
                        ]
                    },
                    {
                        "id": "10492",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T16:53:12.142-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10491",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T16:53:11.828-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10018",
                                "fromString": "READY TO CODE REVIEW",
                                "to": "10019",
                                "toString": "IN CODE REVIEW"
                            }
                        ]
                    },
                    {
                        "id": "10436",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T15:58:14.383-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10435",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T15:58:14.061-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10017",
                                "fromString": "DOING",
                                "to": "10018",
                                "toString": "READY TO CODE REVIEW"
                            }
                        ]
                    },
                    {
                        "id": "10319",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T11:26:15.737-0300",
                        "items": [
                            {
                                "field": "assignee",
                                "fieldtype": "jira",
                                "fieldId": "assignee",
                                "from": null,
                                "fromString": null,
                                "to": "5aea4ab19cfeaf198aeeaf78",
                                "toString": "Wellington Santana",
                                "tmpFromAccountId": null,
                                "tmpToAccountId": "5aea4ab19cfeaf198aeeaf78"
                            }
                        ]
                    },
                    {
                        "id": "10318",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T11:26:05.729-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10015",
                                "fromString": "READY TO DEV",
                                "to": "10017",
                                "toString": "DOING"
                            }
                        ]
                    },
                    {
                        "id": "10265",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:15:16.910-0300",
                        "items": [
                            {
                                "field": "description",
                                "fieldtype": "jira",
                                "fieldId": "description",
                                "from": null,
                                "fromString": "Implementar um sistema de registro integrado que armazene os detalhes dos alunos em um banco de dados central. Isso garantirá que as informações sejam consistentes em todo o sistema e facilitem a recuperação quando necessário.",
                                "to": null,
                                "toString": "Desenvolver um módulo robusto para o cadastro de alunos e posterior vinculação desses alunos a turmas específicas. O sistema deve permitir que usuários administrativos possam inserir detalhes do aluno (como nome, data de nascimento, etc.) e, após o cadastro, vincular esse aluno a uma ou mais turmas.\n\n*Critérios de Aceite:*\n\n# O sistema deve permitir inserir detalhes do aluno, como: nome, data de nascimento, endereço, etc.\n# O sistema deve verificar se um aluno com as mesmas informações não está duplicado.\n# Após o cadastro do aluno, deve ser possível vinculá-lo a uma ou mais turmas.\n# O sistema deve verificar se a turma à qual o aluno está sendo vinculado ainda possui vagas.\n# Deve ser possível editar as informações de um aluno já cadastrado.\n# Deve ser possível remover um aluno (considerando remoção lógica).\n# Ao visualizar uma turma, deve-se listar todos os alunos vinculados a ela.\n# Ao remover um aluno de uma turma, o sistema deve atualizar o número de vagas disponíveis naquela turma.\n\n*Definição de Pronto:*\n\n* A funcionalidade está desenvolvida conforme os critérios de aceite.\n* A funcionalidade passou por testes manuais e automáticos, garantindo que todos os cenários, inclusive de erro, foram testados.\n* O código foi revisado e não possui bugs ou vulnerabilidades críticas.\n* A documentação relacionada à funcionalidade foi atualizada.\n* O módulo foi testado em diferentes dispositivos e navegadores para garantir a compatibilidade.\n* Feedback dos stakeholders foi coletado e considerado durante o desenvolvimento."
                            }
                        ]
                    },
                    {
                        "id": "10264",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:15:00.253-0300",
                        "items": [
                            {
                                "field": "summary",
                                "fieldtype": "jira",
                                "fieldId": "summary",
                                "from": null,
                                "fromString": "Registro Integrado",
                                "to": null,
                                "toString": "Vinculação de alunos a turmas"
                            }
                        ]
                    },
                    {
                        "id": "10089",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-08-22T14:43:30.007-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10088",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-08-22T14:43:29.741-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10014",
                                "fromString": "In Refinement",
                                "to": "10015",
                                "toString": "READY TO DEV"
                            }
                        ]
                    },
                    {
                        "id": "10087",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-08-22T14:43:22.505-0300",
                        "items": [
                            {
                                "field": "description",
                                "fieldtype": "jira",
                                "fieldId": "description",
                                "from": null,
                                "fromString": null,
                                "to": null,
                                "toString": "Implementar um sistema de registro integrado que armazene os detalhes dos alunos em um banco de dados central. Isso garantirá que as informações sejam consistentes em todo o sistema e facilitem a recuperação quando necessário."
                            }
                        ]
                    }
                ],
                "movement": [
                    "In Refinement: 4m 6s",
                    "READY TO DEV: 16d 20h 42m 36s",
                    "DOING: 4h 32m 9s",
                    "READY TO CODE REVIEW: 3d 54m 58s",
                    "IN CODE REVIEW: 18h 47m 47s",
                    "READY TO QA: 1d 22h 12m 37s",
                    "IN QA: 1d 4h 29m 36s",
                    "READY TO DEPLOY: 2d 23h 23m 33s"
                ],
                "issueCreatedAt": "2023-08-22T14:39:22.797-0300",
                "columnName": "Concluído",
                "url": "https://testevanni.atlassian.net/browse/GE-4",
                "updated": "2023-09-18T13:46:45.347-0300",
                "created": "2023-08-22T14:39:22.797-0300",
                "lastViewed": null,
                "issueType": {
                    "name": "Tarefa",
                    "id": "10011",
                    "description": "Uma parte pequena e distinta do trabalho.",
                    "subtask": false
                },
                "project": {
                    "id": "10005",
                    "key": "GE",
                    "name": "Gestão Escolar",
                    "projectTypeKey": "software"
                },
                "priority": {
                    "name": "Medium",
                    "id": "3",
                    "iconUrl": "https://testevanni.atlassian.net/images/icons/priorities/medium.svg"
                },
                "assignee": {
                    "accountId": "5aea4ab19cfeaf198aeeaf78",
                    "emailAddress": "wellington.santana@kodus.io",
                    "displayName": "Wellington Santana",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/5aea4ab19cfeaf198aeeaf78/ca3ee8a2-8990-4fa2-81b9-a8f7087fbe40/48",
                        "24x24": "https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/5aea4ab19cfeaf198aeeaf78/ca3ee8a2-8990-4fa2-81b9-a8f7087fbe40/24",
                        "16x16": "https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/5aea4ab19cfeaf198aeeaf78/ca3ee8a2-8990-4fa2-81b9-a8f7087fbe40/16",
                        "32x32": "https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/5aea4ab19cfeaf198aeeaf78/ca3ee8a2-8990-4fa2-81b9-a8f7087fbe40/32"
                    }
                },
                "status": {
                    "name": "Concluído",
                    "id": "10016",
                    "statusCategory": {
                        "name": "Itens concluídos",
                        "id": 3
                    }
                },
                "creator": {
                    "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                    "displayName": "Junior Sartori",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                    }
                },
                "reporter": {
                    "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                    "displayName": "Junior Sartori",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                    }
                },
                "comment": {
                    "comments": [],
                    "total": 0,
                    "startAt": 0
                },
                "subtasks": []
            },
            {
                "id": "10020",
                "key": "GE-3",
                "name": "Cadastro de Alunos",
                "desc": [
                    {
                        "type": "paragraph",
                        "content": "Criar um formulário abrangente para o cadastro de alunos, abordando detalhes cruciais como nome, data de nascimento, contato de emergência e histórico acadêmico. Isso permitirá que os professores tenham acesso a informações essenciais sobre os alunos."
                    },
                    {
                        "type": "paragraph",
                        "content": "Endereço do aluno"
                    },
                    {
                        "type": "bulletList",
                        "content": [
                            {
                                "title": "Listar todos os estados brasileiros em um dropdown"
                            },
                            {
                                "title": "A partir da seleção do estado, listar todas as cidades pertencentes ao estado (Consumir API dos correios)"
                            },
                            {
                                "title": "Pedir o CEP para o usuário"
                            },
                            {
                                "title": "A partir do CEP preenchido, completar endereço residencial automaticamente (Consumir API dos correios)",
                                "bulletList": [
                                    "Permitir que o usuário edite o endereço, pois cidades pequenas tem um CEP só para tudo"
                                ]
                            },
                            {
                                "title": "Campos obrigatórios",
                                "bulletList": [
                                    "Logradouro",
                                    "Número",
                                    "Bairro",
                                    "CEP",
                                    "Município",
                                    "Estado/UF"
                                ]
                            },
                            {
                                "title": "Campos opcionais",
                                "bulletList": [
                                    "Complemento",
                                    "Ponto de referência",
                                    "Observações"
                                ]
                            }
                        ]
                    }
                ],
                "changelog": [
                    {
                        "id": "10503",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T16:54:47.920-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10502",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T16:54:47.604-0300",
                        "items": [
                            {
                                "field": "resolution",
                                "fieldtype": "jira",
                                "fieldId": "resolution",
                                "from": null,
                                "fromString": null,
                                "to": "10000",
                                "toString": "Done"
                            },
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10022",
                                "fromString": "READY TO DEPLOY",
                                "to": "10016",
                                "toString": "DONE"
                            }
                        ]
                    },
                    {
                        "id": "10306",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T11:25:23.044-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10021",
                                "fromString": "IN QA",
                                "to": "10022",
                                "toString": "READY TO DEPLOY"
                            }
                        ]
                    },
                    {
                        "id": "10279",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:30:19.589-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10020",
                                "fromString": "READY TO QA",
                                "to": "10021",
                                "toString": "IN QA"
                            }
                        ]
                    },
                    {
                        "id": "10278",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:29:40.546-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10019",
                                "fromString": "IN CODE REVIEW",
                                "to": "10020",
                                "toString": "READY TO QA"
                            }
                        ]
                    },
                    {
                        "id": "10255",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:12:22.924-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10018",
                                "fromString": "READY TO CODE REVIEW",
                                "to": "10019",
                                "toString": "IN CODE REVIEW"
                            }
                        ]
                    },
                    {
                        "id": "10226",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:02:17.973-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10017",
                                "fromString": "DOING",
                                "to": "10018",
                                "toString": "READY TO CODE REVIEW"
                            }
                        ]
                    },
                    {
                        "id": "10218",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T09:59:56.865-0300",
                        "items": [
                            {
                                "field": "description",
                                "fieldtype": "jira",
                                "fieldId": "description",
                                "from": null,
                                "fromString": "Criar um formulário abrangente para o cadastro de alunos, abordando detalhes cruciais como nome, data de nascimento, contato de emergência e histórico acadêmico. Isso permitirá que os professores tenham acesso a informações essenciais sobre os alunos.",
                                "to": null,
                                "toString": "Criar um formulário abrangente para o cadastro de alunos, abordando detalhes cruciais como nome, data de nascimento, contato de emergência e histórico acadêmico. Isso permitirá que os professores tenham acesso a informações essenciais sobre os alunos.\n\n*Endereço do aluno*\n\n* Listar todos os estados brasileiros em um dropdown\n* A partir da seleção do estado, listar todas as cidades pertencentes ao estado (Consumir API dos correios)\n* Pedir o CEP para o usuário\n* A partir do CEP preenchido, completar endereço residencial automaticamente (Consumir API dos correios)\n** Permitir que o usuário edite o endereço, pois cidades pequenas tem um CEP só para tudo\n* Campos obrigatórios\n** Logradouro\n** Número\n** Bairro\n** CEP\n** Município\n** Estado/UF\n* Campos opcionais\n** Complemento\n** Ponto de referência\n** Observações"
                            }
                        ]
                    },
                    {
                        "id": "10184",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T09:33:14.558-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10015",
                                "fromString": "READY TO DEV",
                                "to": "10017",
                                "toString": "DOING"
                            }
                        ]
                    },
                    {
                        "id": "10183",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T09:33:04.401-0300",
                        "items": [
                            {
                                "field": "assignee",
                                "fieldtype": "jira",
                                "fieldId": "assignee",
                                "from": null,
                                "fromString": null,
                                "to": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                                "toString": "Junior Sartori",
                                "tmpFromAccountId": null,
                                "tmpToAccountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078"
                            }
                        ]
                    },
                    {
                        "id": "10086",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-08-22T14:43:12.193-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10014",
                                "fromString": "In Refinement",
                                "to": "10015",
                                "toString": "READY TO DEV"
                            }
                        ]
                    },
                    {
                        "id": "10085",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-08-22T14:43:07.763-0300",
                        "items": [
                            {
                                "field": "description",
                                "fieldtype": "jira",
                                "fieldId": "description",
                                "from": null,
                                "fromString": null,
                                "to": null,
                                "toString": "Criar um formulário abrangente para o cadastro de alunos, abordando detalhes cruciais como nome, data de nascimento, contato de emergência e histórico acadêmico. Isso permitirá que os professores tenham acesso a informações essenciais sobre os alunos."
                            }
                        ]
                    }
                ],
                "movement": [
                    "In Refinement: 3m 59s",
                    "READY TO DEV: 13d 18h 50m 2s",
                    "DOING: 29m 4s",
                    "READY TO CODE REVIEW: 10m 5s",
                    "IN CODE REVIEW: 17m 17s",
                    "READY TO QA: 40s",
                    "IN QA: 3d 55m 3s",
                    "READY TO DEPLOY: 3d 5h 29m 25s"
                ],
                "issueCreatedAt": "2023-08-22T14:39:12.588-0300",
                "columnName": "Concluído",
                "url": "https://testevanni.atlassian.net/browse/GE-3",
                "updated": "2023-09-11T16:54:47.896-0300",
                "created": "2023-08-22T14:39:12.588-0300",
                "lastViewed": "2023-09-05T12:15:08.738-0300",
                "issueType": {
                    "name": "Tarefa",
                    "id": "10011",
                    "description": "Uma parte pequena e distinta do trabalho.",
                    "subtask": false
                },
                "project": {
                    "id": "10005",
                    "key": "GE",
                    "name": "Gestão Escolar",
                    "projectTypeKey": "software"
                },
                "priority": {
                    "name": "Medium",
                    "id": "3",
                    "iconUrl": "https://testevanni.atlassian.net/images/icons/priorities/medium.svg"
                },
                "assignee": {
                    "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                    "displayName": "Junior Sartori",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                    }
                },
                "status": {
                    "name": "Concluído",
                    "id": "10016",
                    "statusCategory": {
                        "name": "Itens concluídos",
                        "id": 3
                    }
                },
                "creator": {
                    "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                    "displayName": "Junior Sartori",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                    }
                },
                "reporter": {
                    "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                    "displayName": "Junior Sartori",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                    }
                },
                "comment": {
                    "comments": [
                        {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/issue/10020/comment/10023",
                            "id": "10023",
                            "author": {
                                "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                                "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                                "avatarUrls": {
                                    "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                    "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                    "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                    "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                                },
                                "displayName": "Junior Sartori",
                                "active": true,
                                "timeZone": "America/Sao_Paulo",
                                "accountType": "atlassian"
                            },
                            "body": {
                                "version": 1,
                                "type": "doc",
                                "content": [
                                    {
                                        "type": "paragraph",
                                        "content": [
                                            {
                                                "type": "text",
                                                "text": "A atividade foi criada com uma descrição muita simplista sobre o que precisa ser feito, e precisei realinhar várias vezes com o P.O. sobre isso. Causou muito atraso no desenvolvimento"
                                            }
                                        ]
                                    }
                                ]
                            },
                            "updateAuthor": {
                                "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                                "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                                "avatarUrls": {
                                    "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                    "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                    "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                    "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                                },
                                "displayName": "Junior Sartori",
                                "active": true,
                                "timeZone": "America/Sao_Paulo",
                                "accountType": "atlassian"
                            },
                            "created": "2023-09-05T09:55:38.471-0300",
                            "updated": "2023-09-05T09:55:38.471-0300",
                            "jsdPublic": true
                        }
                    ],
                    "total": 1,
                    "startAt": 0
                },
                "subtasks": [
                    {
                        "id": "10038",
                        "key": "GE-9",
                        "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/issue/10038",
                        "fields": {
                            "summary": "Cadastro de pais de alunos",
                            "status": {
                                "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/status/10016",
                                "description": "",
                                "iconUrl": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/",
                                "name": "Concluído",
                                "id": "10016",
                                "statusCategory": {
                                    "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/statuscategory/3",
                                    "id": 3,
                                    "key": "done",
                                    "colorName": "green",
                                    "name": "Itens concluídos"
                                }
                            },
                            "priority": {
                                "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/priority/3",
                                "iconUrl": "https://testevanni.atlassian.net/images/icons/priorities/medium.svg",
                                "name": "Medium",
                                "id": "3"
                            },
                            "issuetype": {
                                "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/issuetype/10013",
                                "id": "10013",
                                "description": "As subtarefas monitoram pequenas partes do trabalho que fazem parte de uma tarefa maior.",
                                "iconUrl": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/2/universal_avatar/view/type/issuetype/avatar/10316?size=medium",
                                "name": "Subtarefa",
                                "subtask": true,
                                "avatarId": 10316,
                                "entityId": "fb817290-02f6-4703-a874-8cc900d21cc6",
                                "hierarchyLevel": -1
                            }
                        }
                    },
                    {
                        "id": "10039",
                        "key": "GE-10",
                        "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/issue/10039",
                        "fields": {
                            "summary": "Login dos alunos",
                            "status": {
                                "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/status/10021",
                                "description": "",
                                "iconUrl": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/",
                                "name": "IN QA",
                                "id": "10021",
                                "statusCategory": {
                                    "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/statuscategory/4",
                                    "id": 4,
                                    "key": "indeterminate",
                                    "colorName": "yellow",
                                    "name": "Em andamento"
                                }
                            },
                            "priority": {
                                "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/priority/3",
                                "iconUrl": "https://testevanni.atlassian.net/images/icons/priorities/medium.svg",
                                "name": "Medium",
                                "id": "3"
                            },
                            "issuetype": {
                                "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/issuetype/10013",
                                "id": "10013",
                                "description": "As subtarefas monitoram pequenas partes do trabalho que fazem parte de uma tarefa maior.",
                                "iconUrl": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/2/universal_avatar/view/type/issuetype/avatar/10316?size=medium",
                                "name": "Subtarefa",
                                "subtask": true,
                                "avatarId": 10316,
                                "entityId": "fb817290-02f6-4703-a874-8cc900d21cc6",
                                "hierarchyLevel": -1
                            }
                        }
                    },
                    {
                        "id": "10040",
                        "key": "GE-11",
                        "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/issue/10040",
                        "fields": {
                            "summary": "Cadastro de responsáveis que podem buscar a criança na escola",
                            "status": {
                                "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/status/10016",
                                "description": "",
                                "iconUrl": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/",
                                "name": "Concluído",
                                "id": "10016",
                                "statusCategory": {
                                    "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/statuscategory/3",
                                    "id": 3,
                                    "key": "done",
                                    "colorName": "green",
                                    "name": "Itens concluídos"
                                }
                            },
                            "priority": {
                                "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/priority/3",
                                "iconUrl": "https://testevanni.atlassian.net/images/icons/priorities/medium.svg",
                                "name": "Medium",
                                "id": "3"
                            },
                            "issuetype": {
                                "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/issuetype/10013",
                                "id": "10013",
                                "description": "As subtarefas monitoram pequenas partes do trabalho que fazem parte de uma tarefa maior.",
                                "iconUrl": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/2/universal_avatar/view/type/issuetype/avatar/10316?size=medium",
                                "name": "Subtarefa",
                                "subtask": true,
                                "avatarId": 10316,
                                "entityId": "fb817290-02f6-4703-a874-8cc900d21cc6",
                                "hierarchyLevel": -1
                            }
                        }
                    }
                ]
            },
            {
                "id": "10019",
                "key": "GE-2",
                "name": "Autenticação Avançada",
                "desc": [
                    {
                        "type": "paragraph",
                        "content": "Implementar um sistema de autenticação avançada, incluindo autenticação de dois fatores, para garantir que apenas os professores autorizados tenham acesso ao portal. Isso ajudará a proteger os dados acadêmicos e pessoais dos alunos e professores."
                    }
                ],
                "changelog": [
                    {
                        "id": "10499",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T16:53:42.440-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10498",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T16:53:42.206-0300",
                        "items": [
                            {
                                "field": "resolution",
                                "fieldtype": "jira",
                                "fieldId": "resolution",
                                "from": null,
                                "fromString": null,
                                "to": "10000",
                                "toString": "Done"
                            },
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10022",
                                "fromString": "READY TO DEPLOY",
                                "to": "10016",
                                "toString": "DONE"
                            }
                        ]
                    },
                    {
                        "id": "10475",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T08:16:14.194-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked lower"
                            }
                        ]
                    },
                    {
                        "id": "10474",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-11T08:16:13.921-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10021",
                                "fromString": "IN QA",
                                "to": "10022",
                                "toString": "READY TO DEPLOY"
                            }
                        ]
                    },
                    {
                        "id": "10443",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T15:58:44.035-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked higher"
                            }
                        ]
                    },
                    {
                        "id": "10442",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T15:58:43.746-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10020",
                                "fromString": "READY TO QA",
                                "to": "10021",
                                "toString": "IN QA"
                            }
                        ]
                    },
                    {
                        "id": "10429",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T15:57:35.741-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10019",
                                "fromString": "IN CODE REVIEW",
                                "to": "10020",
                                "toString": "READY TO QA"
                            }
                        ]
                    },
                    {
                        "id": "10305",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-08T11:25:16.472-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10018",
                                "fromString": "READY TO CODE REVIEW",
                                "to": "10019",
                                "toString": "IN CODE REVIEW"
                            }
                        ]
                    },
                    {
                        "id": "10254",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:09:19.149-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked lower"
                            }
                        ]
                    },
                    {
                        "id": "10253",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T10:09:18.865-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10017",
                                "fromString": "DOING",
                                "to": "10018",
                                "toString": "READY TO CODE REVIEW"
                            }
                        ]
                    },
                    {
                        "id": "10210",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T09:52:44.853-0300",
                        "items": [
                            {
                                "field": "Rank",
                                "fieldtype": "custom",
                                "fieldId": "customfield_10019",
                                "from": "",
                                "fromString": "",
                                "to": "",
                                "toString": "Ranked lower"
                            }
                        ]
                    },
                    {
                        "id": "10209",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-09-05T09:52:44.482-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10015",
                                "fromString": "READY TO DEV",
                                "to": "10017",
                                "toString": "DOING"
                            }
                        ]
                    },
                    {
                        "id": "10084",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-08-22T14:43:00.319-0300",
                        "items": [
                            {
                                "field": "status",
                                "fieldtype": "jira",
                                "fieldId": "status",
                                "from": "10014",
                                "fromString": "In Refinement",
                                "to": "10015",
                                "toString": "READY TO DEV"
                            }
                        ]
                    },
                    {
                        "id": "10082",
                        "author": {
                            "self": "https://api.atlassian.com/ex/jira/13e4b97d-175e-41f7-a51d-86f71402b772/rest/api/3/user?accountId=712020%3A41ba5bc5-951b-4102-950e-d646397d5078",
                            "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                            "avatarUrls": {
                                "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                                "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                            },
                            "displayName": "Junior Sartori",
                            "active": true,
                            "timeZone": "America/Sao_Paulo",
                            "accountType": "atlassian"
                        },
                        "created": "2023-08-22T14:42:54.476-0300",
                        "items": [
                            {
                                "field": "description",
                                "fieldtype": "jira",
                                "fieldId": "description",
                                "from": null,
                                "fromString": null,
                                "to": null,
                                "toString": "Implementar um sistema de autenticação avançada, incluindo autenticação de dois fatores, para garantir que apenas os professores autorizados tenham acesso ao portal. Isso ajudará a proteger os dados acadêmicos e pessoais dos alunos e professores."
                            }
                        ]
                    }
                ],
                "movement": [
                    "In Refinement: 3m 52s",
                    "READY TO DEV: 13d 19h 9m 44s",
                    "DOING: 16m 34s",
                    "READY TO CODE REVIEW: 3d 1h 15m 58s",
                    "IN CODE REVIEW: 4h 32m 19s",
                    "READY TO QA: 1m 8s",
                    "IN QA: 2d 16h 17m 30s",
                    "READY TO DEPLOY: 8h 37m 29s"
                ],
                "issueCreatedAt": "2023-08-22T14:39:08.043-0300",
                "columnName": "Concluído",
                "url": "https://testevanni.atlassian.net/browse/GE-2",
                "updated": "2023-09-11T16:53:42.432-0300",
                "created": "2023-08-22T14:39:08.043-0300",
                "lastViewed": null,
                "issueType": {
                    "name": "Tarefa",
                    "id": "10011",
                    "description": "Uma parte pequena e distinta do trabalho.",
                    "subtask": false
                },
                "project": {
                    "id": "10005",
                    "key": "GE",
                    "name": "Gestão Escolar",
                    "projectTypeKey": "software"
                },
                "priority": {
                    "name": "Medium",
                    "id": "3",
                    "iconUrl": "https://testevanni.atlassian.net/images/icons/priorities/medium.svg"
                },
                "assignee": {},
                "status": {
                    "name": "Concluído",
                    "id": "10016",
                    "statusCategory": {
                        "name": "Itens concluídos",
                        "id": 3
                    }
                },
                "creator": {
                    "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                    "displayName": "Junior Sartori",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                    }
                },
                "reporter": {
                    "accountId": "712020:41ba5bc5-951b-4102-950e-d646397d5078",
                    "displayName": "Junior Sartori",
                    "active": true,
                    "avatarUrls": {
                        "48x48": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "24x24": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "16x16": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png",
                        "32x32": "https://secure.gravatar.com/avatar/65585438b8ab4a16294d3f703d23d37e?d=https%3A%2F%2Favatar-management--avatars.us-west-2.prod.public.atl-paas.net%2Finitials%2FJS-4.png"
                    }
                },
                "comment": {
                    "comments": [],
                    "total": 0,
                    "startAt": 0
                },
                "subtasks": []
            }
        ]
    }
]

module.exports = issuesData;
