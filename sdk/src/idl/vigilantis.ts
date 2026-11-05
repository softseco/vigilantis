/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/vigilantis.json`.
 */
export type Vigilantis = {
  "address": "4DoDFZJmJWYuBx86UqXi3y24GkQ3Cq4nUBHZwDE5PQM5",
  "metadata": {
    "name": "vigilantis",
    "version": "1.0.0-rc.2",
    "spec": "0.1.0",
    "description": "Programmable compliance for Token-2022 tokenized assets, built on Transfer Hooks."
  },
  "instructions": [
    {
      "name": "acceptAuthority",
      "docs": [
        "Complete the handover: the proposed authority signs and becomes the policy authority."
      ],
      "discriminator": [
        107,
        86,
        198,
        91,
        33,
        12,
        107,
        160
      ],
      "accounts": [
        {
          "name": "newAuthority",
          "signer": true
        },
        {
          "name": "previousAuthority",
          "writable": true
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "pendingAuthority",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "addToAllowlist",
      "docs": [
        "Add a wallet to a mint's allowlist by creating its `AllowEntry` PDA. The admin, or a holder",
        "of `permission::ALLOWLIST`."
      ],
      "discriminator": [
        149,
        143,
        78,
        134,
        241,
        244,
        7,
        56
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "wallet"
        },
        {
          "name": "allowEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  108,
                  108,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "wallet"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "role",
          "docs": [
            "The signer's `RoleEntry` for this mint, when the signer is not the admin."
          ],
          "optional": true
        }
      ],
      "args": []
    },
    {
      "name": "addToBlocklist",
      "docs": [
        "Add a wallet to a mint's blocklist by creating its `BlockEntry` PDA. The admin, or a holder",
        "of `permission::BLOCK`."
      ],
      "discriminator": [
        201,
        138,
        75,
        216,
        252,
        201,
        26,
        106
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "wallet"
        },
        {
          "name": "blockEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  108,
                  111,
                  99,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "wallet"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "role",
          "docs": [
            "The signer's `RoleEntry` for this mint, when the signer is not the admin."
          ],
          "optional": true
        }
      ],
      "args": []
    },
    {
      "name": "blockWallet",
      "docs": [
        "`add_to_blocklist`, recording why: also emits `EnforcementAction` with the issuer's",
        "`reason_code` and `case_ref` (for example a salted hash of its case number)."
      ],
      "discriminator": [
        132,
        75,
        123,
        1,
        97,
        186,
        159,
        194
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "wallet"
        },
        {
          "name": "blockEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  108,
                  111,
                  99,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "wallet"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "role",
          "docs": [
            "The signer's `RoleEntry` for this mint, when the signer is not the admin."
          ],
          "optional": true
        }
      ],
      "args": [
        {
          "name": "reasonCode",
          "type": "u16"
        },
        {
          "name": "caseRef",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "cancelAuthorityTransfer",
      "docs": [
        "Withdraw a pending proposal. Only the current authority may call this."
      ],
      "discriminator": [
        94,
        131,
        125,
        184,
        183,
        24,
        125,
        229
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "pendingAuthority",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "closeSeizure",
      "docs": [
        "Close a `SeizureRecord` once the case is settled, recording the outcome. The admin, or a",
        "holder of `permission::CLOSE_SEIZURE`. The record's rent goes to the signer; the events of",
        "the seizure and of its closing stay in the chain's history."
      ],
      "discriminator": [
        13,
        139,
        168,
        58,
        93,
        106,
        122,
        1
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "seizureRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  105,
                  122,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "seizure_record.token_account",
                "account": "seizureRecord"
              },
              {
                "kind": "account",
                "path": "seizure_record.case_ref",
                "account": "seizureRecord"
              }
            ]
          }
        },
        {
          "name": "role",
          "docs": [
            "The signer's `RoleEntry` for this mint, when the signer is not the admin."
          ],
          "optional": true
        }
      ],
      "args": [
        {
          "name": "outcome",
          "type": {
            "defined": {
              "name": "seizureOutcome"
            }
          }
        },
        {
          "name": "reasonCode",
          "type": "u16"
        }
      ]
    },
    {
      "name": "forfeit",
      "docs": [
        "End a case whose funds cannot be seized: the token account stays frozen for good. The",
        "admin, or a holder of `permission::SEIZE`; `case_ref` must not be all zeros.",
        "",
        "This is for a balance that `seize` cannot reach, above all a confidential one, which only its",
        "owner's proofs can move. The account must have been frozen through Vigilantis at least",
        "`SEIZE_DELAY_SECONDS` before and still be frozen. Vigilantis then keeps a `ForfeitureRecord`",
        "for it, and `thaw_token_account` refuses the account for as long as the record exists; only",
        "the admin can remove it, with `release_forfeiture` (for example after an appeal). Nothing is",
        "burnt or moved: the tokens stay in the supply, and the issuer reports them apart from the",
        "supply in circulation.",
        "",
        "`amount_commitment` is the issuer's own and optional (all zeros for none), for example",
        "SHA-256 of a salt and the amount its auditor key shows, so that the amount can be proven later",
        "without putting it on-chain. Vigilantis does not check it."
      ],
      "discriminator": [
        80,
        154,
        237,
        158,
        244,
        198,
        154,
        9
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "The admin or a role holder; pays for the `ForfeitureRecord`."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenAccount"
        },
        {
          "name": "freezeRecord",
          "docs": [
            "When Vigilantis froze `token_account`; without one, the account cannot be forfeited."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  114,
                  101,
                  101,
                  122,
                  101,
                  45,
                  114,
                  101,
                  99,
                  111,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "tokenAccount"
              }
            ]
          }
        },
        {
          "name": "forfeitureRecord",
          "docs": [
            "One per token account: a second `forfeit` of the same account fails."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  111,
                  114,
                  102,
                  101,
                  105,
                  116,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "tokenAccount"
              }
            ]
          }
        },
        {
          "name": "freezeAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  114,
                  101,
                  101,
                  122,
                  101,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "role",
          "docs": [
            "The signer's `RoleEntry` for this mint, when the signer is not the admin."
          ],
          "optional": true
        }
      ],
      "args": [
        {
          "name": "reasonCode",
          "type": "u16"
        },
        {
          "name": "caseRef",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "amountCommitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "freezeTokenAccount",
      "docs": [
        "Freeze one token account of the mint: Token-2022 then refuses every instruction on it",
        "(transfers in and out, burns, approvals, confidential deposits, transfers and withdrawals)",
        "until it is thawed. The admin, or a holder of `permission::FREEZE`, and only for a mint",
        "whose freeze authority is Vigilantis's freeze-authority address for that mint.",
        "",
        "Also writes the account's `FreezeRecord` (the time of this freeze), which `seize` needs; the",
        "signer pays its rent."
      ],
      "discriminator": [
        138,
        168,
        178,
        109,
        205,
        224,
        209,
        93
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "The admin or a role holder; pays for the `FreezeRecord` of a freeze and gets it back on a",
            "thaw."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenAccount",
          "docs": [
            "program, mint, current state); Vigilantis only reads its owner for the event."
          ],
          "writable": true
        },
        {
          "name": "freezeAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  114,
                  101,
                  101,
                  122,
                  101,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "freezeRecord",
          "docs": [
            "by a thaw; it may not exist (an account frozen before 1.0 or by another freeze authority)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  114,
                  101,
                  101,
                  122,
                  101,
                  45,
                  114,
                  101,
                  99,
                  111,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "tokenAccount"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "forfeitureRecord",
          "docs": [
            "a thaw is refused (`require_not_forfeited`). A freeze does not read it."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  111,
                  114,
                  102,
                  101,
                  105,
                  116,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "tokenAccount"
              }
            ]
          }
        },
        {
          "name": "role",
          "docs": [
            "The signer's `RoleEntry` for this mint, when the signer is not the admin."
          ],
          "optional": true
        }
      ],
      "args": [
        {
          "name": "reasonCode",
          "type": "u16"
        },
        {
          "name": "caseRef",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "grantRole",
      "docs": [
        "Give `holder` a role with `permissions` (bits of [`permission`]). The admin only."
      ],
      "discriminator": [
        218,
        234,
        128,
        15,
        82,
        33,
        236,
        253
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "holder"
        },
        {
          "name": "role",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "holder"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "permissions",
          "type": "u16"
        }
      ]
    },
    {
      "name": "initializeExtraAccountMetaList",
      "docs": [
        "Create and initialize the `ExtraAccountMetaList` PDA for `mint`, declaring",
        "the accounts the hook needs on every transfer: the policy config, the",
        "sender's and recipient's blocklist entries, and the recipient's allowlist",
        "entry (all resolved from the transfer's own accounts)."
      ],
      "discriminator": [
        92,
        197,
        174,
        197,
        41,
        124,
        19,
        3
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "extraAccountMetaList",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  116,
                  114,
                  97,
                  45,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116,
                  45,
                  109,
                  101,
                  116,
                  97,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initializePolicy",
      "docs": [
        "Create the mint's `PolicyConfig`. The signer becomes its authority."
      ],
      "discriminator": [
        9,
        186,
        86,
        225,
        129,
        162,
        231,
        56
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "allowlistEnabled",
          "type": "bool"
        },
        {
          "name": "blocklistEnabled",
          "type": "bool"
        },
        {
          "name": "maxTransferAmount",
          "type": "u64"
        },
        {
          "name": "allowConfidential",
          "type": "bool"
        }
      ]
    },
    {
      "name": "pause",
      "docs": [
        "Stop the whole token: Token-2022 then refuses every transfer, mint and burn of it,",
        "confidential ones included, until `resume`. Freezing and thawing still work. The admin, or a",
        "holder of `permission::PAUSE`, and only for a Pausable mint whose pause authority is",
        "Vigilantis's pause-authority address for that mint."
      ],
      "discriminator": [
        211,
        22,
        221,
        251,
        74,
        121,
        193,
        47
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "mint",
          "docs": [
            "and Token-2022 checks the rest."
          ],
          "writable": true
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "pauseAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  117,
                  115,
                  101,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "role",
          "docs": [
            "The signer's `RoleEntry` for this mint, when the signer is not the admin."
          ],
          "optional": true
        }
      ],
      "args": [
        {
          "name": "reasonCode",
          "type": "u16"
        },
        {
          "name": "caseRef",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "proposeAuthority",
      "docs": [
        "Start handing the policy to `new_authority` (for example a multisig vault). Nothing",
        "changes until `new_authority` accepts, so a mistyped address cannot lock the policy."
      ],
      "discriminator": [
        20,
        148,
        236,
        198,
        76,
        119,
        99,
        142
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "pendingAuthority",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "newAuthority",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "releaseForfeiture",
      "docs": [
        "Remove a `ForfeitureRecord`, for example when a court lifts the forfeiture on appeal, so that",
        "the account can be thawed again. The admin only, never a role holder: this is the one way",
        "back from `forfeit`. The record's rent goes to the admin; the events of the forfeiture and of",
        "its release stay in the chain's history. The account stays frozen until a",
        "`thaw_token_account`."
      ],
      "discriminator": [
        99,
        218,
        93,
        72,
        16,
        230,
        190,
        131
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "The admin; gets the record's rent."
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "forfeitureRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  111,
                  114,
                  102,
                  101,
                  105,
                  116,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "forfeiture_record.token_account",
                "account": "forfeitureRecord"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "reasonCode",
          "type": "u16"
        }
      ]
    },
    {
      "name": "removeFromAllowlist",
      "docs": [
        "Remove a wallet from a mint's allowlist by closing its `AllowEntry` PDA. The admin, or a",
        "holder of `permission::ALLOWLIST`."
      ],
      "discriminator": [
        45,
        46,
        214,
        56,
        189,
        77,
        242,
        227
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "wallet"
        },
        {
          "name": "allowEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  108,
                  108,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "wallet"
              }
            ]
          }
        },
        {
          "name": "role",
          "docs": [
            "The signer's `RoleEntry` for this mint, when the signer is not the admin."
          ],
          "optional": true
        }
      ],
      "args": []
    },
    {
      "name": "removeFromBlocklist",
      "docs": [
        "Remove a wallet from a mint's blocklist by closing its `BlockEntry` PDA. The admin, or a",
        "holder of `permission::UNBLOCK`."
      ],
      "discriminator": [
        132,
        125,
        30,
        120,
        139,
        22,
        210,
        90
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "wallet"
        },
        {
          "name": "blockEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  108,
                  111,
                  99,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "wallet"
              }
            ]
          }
        },
        {
          "name": "role",
          "docs": [
            "The signer's `RoleEntry` for this mint, when the signer is not the admin."
          ],
          "optional": true
        }
      ],
      "args": []
    },
    {
      "name": "renounceRole",
      "docs": [
        "Give up one's own role, for example when its key may be stolen. Signed by the holder; the",
        "rent goes to the holder."
      ],
      "discriminator": [
        21,
        253,
        233,
        162,
        186,
        216,
        217,
        26
      ],
      "accounts": [
        {
          "name": "holder",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "role",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "holder"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "resume",
      "docs": [
        "End a pause. The admin, or a holder of `permission::RESUME`."
      ],
      "discriminator": [
        1,
        166,
        51,
        170,
        127,
        32,
        141,
        206
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "mint",
          "docs": [
            "and Token-2022 checks the rest."
          ],
          "writable": true
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "pauseAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  117,
                  115,
                  101,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "role",
          "docs": [
            "The signer's `RoleEntry` for this mint, when the signer is not the admin."
          ],
          "optional": true
        }
      ],
      "args": [
        {
          "name": "reasonCode",
          "type": "u16"
        },
        {
          "name": "caseRef",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "revokeRole",
      "docs": [
        "Take a role away. The admin only; the rent goes to the admin."
      ],
      "discriminator": [
        179,
        232,
        2,
        180,
        48,
        227,
        82,
        7
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "role",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "role.holder",
                "account": "roleEntry"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "seize",
      "docs": [
        "Burn the public balance of a token account under a court order. The admin, or a holder of",
        "`permission::SEIZE`; `case_ref` must not be all zeros.",
        "",
        "The account must have been frozen through Vigilantis at least `SEIZE_DELAY_SECONDS` before",
        "and still be frozen, and the mint's permanent delegate must be Vigilantis's",
        "permanent-delegate address. In one instruction Vigilantis thaws the account, burns its whole",
        "public balance as the permanent delegate, and freezes it again. The reserve behind the burnt",
        "tokens stays with the issuer for the case; paying out under the judgment is a separate step.",
        "A `SeizureRecord` stays open until `close_seizure`. A confidential balance is not touched."
      ],
      "discriminator": [
        129,
        159,
        143,
        31,
        161,
        224,
        241,
        84
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "The admin or a role holder; pays for the `SeizureRecord`."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenAccount",
          "docs": [
            "and Token-2022 checks it again in the thaw, burn and freeze."
          ],
          "writable": true
        },
        {
          "name": "freezeRecord",
          "docs": [
            "When Vigilantis froze `token_account`; without one, the account cannot be seized."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  114,
                  101,
                  101,
                  122,
                  101,
                  45,
                  114,
                  101,
                  99,
                  111,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "tokenAccount"
              }
            ]
          }
        },
        {
          "name": "seizureRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  105,
                  122,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "tokenAccount"
              },
              {
                "kind": "arg",
                "path": "caseRef"
              }
            ]
          }
        },
        {
          "name": "freezeAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  114,
                  101,
                  101,
                  122,
                  101,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "permanentDelegate",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  97,
                  110,
                  101,
                  110,
                  116,
                  45,
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "role",
          "docs": [
            "The signer's `RoleEntry` for this mint, when the signer is not the admin."
          ],
          "optional": true
        }
      ],
      "args": [
        {
          "name": "reasonCode",
          "type": "u16"
        },
        {
          "name": "caseRef",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "setFreezeAuthority",
      "docs": [
        "Hand the mint's freeze authority from Vigilantis to `new_freeze_authority` (for example a",
        "newer compliance program, or the issuer's own multisig), or give it up for good with `None`.",
        "Only the policy authority may do this, and only while Vigilantis holds the freeze authority.",
        "From then on Vigilantis can no longer freeze or thaw the mint's accounts; whoever holds the",
        "freeze authority can hand it back with Token-2022 `SetAuthority`. The move is recorded in",
        "`FreezeAuthorityChanged`, with the issuer's reason."
      ],
      "discriminator": [
        159,
        131,
        149,
        192,
        109,
        186,
        68,
        227
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "freezeAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  114,
                  101,
                  101,
                  122,
                  101,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": [
        {
          "name": "newFreezeAuthority",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "reasonCode",
          "type": "u16"
        },
        {
          "name": "caseRef",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "setPauseAuthority",
      "docs": [
        "Hand the mint's pause authority from Vigilantis to `new_pause_authority`, or give it up for",
        "good with `None`. The admin only, and only while Vigilantis holds the pause authority. The",
        "move is recorded in `PauseAuthorityChanged`."
      ],
      "discriminator": [
        127,
        70,
        214,
        12,
        172,
        8,
        89,
        114
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "pauseAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  97,
                  117,
                  115,
                  101,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": [
        {
          "name": "newPauseAuthority",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "reasonCode",
          "type": "u16"
        },
        {
          "name": "caseRef",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "thawTokenAccount",
      "docs": [
        "Thaw a token account frozen with `freeze_token_account` (or by any earlier holder of the",
        "mint's freeze authority). The admin, or a holder of `permission::THAW`. Deletes the",
        "account's `FreezeRecord`, if there is one, and returns its rent to the signer. Refused while",
        "the account has a `ForfeitureRecord` (`AccountForfeited`), the admin's thaw included."
      ],
      "discriminator": [
        199,
        172,
        96,
        93,
        244,
        252,
        137,
        171
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "The admin or a role holder; pays for the `FreezeRecord` of a freeze and gets it back on a",
            "thaw."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenAccount",
          "docs": [
            "program, mint, current state); Vigilantis only reads its owner for the event."
          ],
          "writable": true
        },
        {
          "name": "freezeAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  114,
                  101,
                  101,
                  122,
                  101,
                  45,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "freezeRecord",
          "docs": [
            "by a thaw; it may not exist (an account frozen before 1.0 or by another freeze authority)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  114,
                  101,
                  101,
                  122,
                  101,
                  45,
                  114,
                  101,
                  99,
                  111,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "tokenAccount"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "forfeitureRecord",
          "docs": [
            "a thaw is refused (`require_not_forfeited`). A freeze does not read it."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  111,
                  114,
                  102,
                  101,
                  105,
                  116,
                  117,
                  114,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "tokenAccount"
              }
            ]
          }
        },
        {
          "name": "role",
          "docs": [
            "The signer's `RoleEntry` for this mint, when the signer is not the admin."
          ],
          "optional": true
        }
      ],
      "args": [
        {
          "name": "reasonCode",
          "type": "u16"
        },
        {
          "name": "caseRef",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "transferHook",
      "docs": [
        "Invoked by Token-2022 on every transfer. Enforces the mint's policy.",
        "",
        "A refusal emits `TransferRefused` before returning the error, so indexers can read the",
        "reason from the failed transaction's logs."
      ],
      "discriminator": [
        220,
        57,
        220,
        152,
        126,
        125,
        97,
        168
      ],
      "accounts": [
        {
          "name": "sourceToken"
        },
        {
          "name": "mint"
        },
        {
          "name": "destinationToken"
        },
        {
          "name": "owner"
        },
        {
          "name": "extraAccountMetaList",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  116,
                  114,
                  97,
                  45,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116,
                  45,
                  109,
                  101,
                  116,
                  97,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "sourceBlock"
        },
        {
          "name": "destBlock"
        },
        {
          "name": "allowEntry"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "unblockWallet",
      "docs": [
        "`remove_from_blocklist`, recording why (`EnforcementAction`)."
      ],
      "discriminator": [
        123,
        52,
        119,
        61,
        139,
        43,
        126,
        73
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "wallet"
        },
        {
          "name": "blockEntry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  108,
                  111,
                  99,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "wallet"
              }
            ]
          }
        },
        {
          "name": "role",
          "docs": [
            "The signer's `RoleEntry` for this mint, when the signer is not the admin."
          ],
          "optional": true
        }
      ],
      "args": [
        {
          "name": "reasonCode",
          "type": "u16"
        },
        {
          "name": "caseRef",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "updateExtraAccountMetaList",
      "docs": [
        "Rewrite a mint's `ExtraAccountMetaList` to the current list, growing the account if",
        "needed. Mints initialized before 2.1 run this once so the hook also receives the transfer",
        "authority's blocklist entry. The list's content is fixed by the program; only the policy",
        "authority may trigger the rewrite, and it pays for any extra rent."
      ],
      "discriminator": [
        44,
        125,
        141,
        226,
        97,
        179,
        166,
        96
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "extraAccountMetaList",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  116,
                  114,
                  97,
                  45,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116,
                  45,
                  109,
                  101,
                  116,
                  97,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "updatePolicy",
      "docs": [
        "Update the mint's policy. Only the policy authority may call this."
      ],
      "discriminator": [
        212,
        245,
        246,
        7,
        163,
        151,
        18,
        57
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "allowlistEnabled",
          "type": "bool"
        },
        {
          "name": "blocklistEnabled",
          "type": "bool"
        },
        {
          "name": "maxTransferAmount",
          "type": "u64"
        },
        {
          "name": "allowConfidential",
          "type": "bool"
        }
      ]
    },
    {
      "name": "updateRole",
      "docs": [
        "Change the permissions of an existing role. The admin only."
      ],
      "discriminator": [
        36,
        223,
        162,
        98,
        168,
        209,
        75,
        151
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "policyConfig"
          ]
        },
        {
          "name": "mint"
        },
        {
          "name": "policyConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  108,
                  105,
                  99,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "role",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              },
              {
                "kind": "account",
                "path": "role.holder",
                "account": "roleEntry"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "permissions",
          "type": "u16"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "allowEntry",
      "discriminator": [
        3,
        29,
        6,
        254,
        2,
        209,
        219,
        245
      ]
    },
    {
      "name": "blockEntry",
      "discriminator": [
        160,
        179,
        255,
        246,
        122,
        148,
        254,
        143
      ]
    },
    {
      "name": "forfeitureRecord",
      "discriminator": [
        106,
        182,
        173,
        239,
        177,
        244,
        0,
        118
      ]
    },
    {
      "name": "freezeRecord",
      "discriminator": [
        33,
        176,
        111,
        25,
        29,
        174,
        180,
        197
      ]
    },
    {
      "name": "pendingAuthority",
      "discriminator": [
        108,
        91,
        208,
        174,
        216,
        189,
        207,
        93
      ]
    },
    {
      "name": "policyConfig",
      "discriminator": [
        219,
        7,
        79,
        84,
        175,
        51,
        148,
        146
      ]
    },
    {
      "name": "roleEntry",
      "discriminator": [
        161,
        238,
        39,
        6,
        64,
        179,
        124,
        31
      ]
    },
    {
      "name": "seizureRecord",
      "discriminator": [
        223,
        239,
        19,
        37,
        166,
        60,
        246,
        226
      ]
    }
  ],
  "events": [
    {
      "name": "authorityTransferCancelled",
      "discriminator": [
        31,
        228,
        187,
        148,
        20,
        99,
        237,
        48
      ]
    },
    {
      "name": "authorityTransferProposed",
      "discriminator": [
        103,
        244,
        27,
        116,
        177,
        4,
        100,
        119
      ]
    },
    {
      "name": "authorityTransferred",
      "discriminator": [
        245,
        109,
        179,
        54,
        135,
        92,
        22,
        64
      ]
    },
    {
      "name": "enforcementAction",
      "discriminator": [
        20,
        159,
        238,
        27,
        33,
        176,
        40,
        223
      ]
    },
    {
      "name": "forfeited",
      "discriminator": [
        80,
        140,
        117,
        204,
        15,
        230,
        158,
        241
      ]
    },
    {
      "name": "forfeitureReleased",
      "discriminator": [
        129,
        199,
        0,
        212,
        189,
        242,
        241,
        76
      ]
    },
    {
      "name": "freezeAuthorityChanged",
      "discriminator": [
        145,
        47,
        128,
        176,
        128,
        227,
        80,
        155
      ]
    },
    {
      "name": "listEntryAdded",
      "discriminator": [
        254,
        152,
        108,
        37,
        231,
        44,
        230,
        119
      ]
    },
    {
      "name": "listEntryRemoved",
      "discriminator": [
        157,
        60,
        145,
        12,
        47,
        48,
        254,
        47
      ]
    },
    {
      "name": "metaListUpdated",
      "discriminator": [
        170,
        131,
        210,
        101,
        188,
        39,
        126,
        26
      ]
    },
    {
      "name": "pauseAuthorityChanged",
      "discriminator": [
        189,
        140,
        155,
        68,
        40,
        110,
        29,
        128
      ]
    },
    {
      "name": "policyInitialized",
      "discriminator": [
        102,
        184,
        59,
        178,
        235,
        69,
        251,
        181
      ]
    },
    {
      "name": "policyUpdated",
      "discriminator": [
        225,
        112,
        112,
        67,
        95,
        236,
        245,
        161
      ]
    },
    {
      "name": "roleChanged",
      "discriminator": [
        85,
        88,
        130,
        5,
        125,
        143,
        206,
        240
      ]
    },
    {
      "name": "seized",
      "discriminator": [
        197,
        48,
        203,
        203,
        174,
        37,
        100,
        65
      ]
    },
    {
      "name": "seizureClosed",
      "discriminator": [
        127,
        215,
        255,
        92,
        140,
        231,
        246,
        206
      ]
    },
    {
      "name": "transferRefused",
      "discriminator": [
        28,
        112,
        75,
        245,
        67,
        66,
        237,
        197
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "recipientNotAllowlisted",
      "msg": "Recipient is not on the allowlist for this mint"
    },
    {
      "code": 6001,
      "name": "transferExceedsLimit",
      "msg": "Transfer amount exceeds the policy limit"
    },
    {
      "code": 6002,
      "name": "senderBlocked",
      "msg": "Sender is blocklisted for this mint"
    },
    {
      "code": 6003,
      "name": "recipientBlocked",
      "msg": "Recipient is blocklisted for this mint"
    },
    {
      "code": 6004,
      "name": "unauthorized",
      "msg": "The signer is neither the policy authority nor a role holder with this permission"
    },
    {
      "code": 6005,
      "name": "confidentialAmountNotEnforceable",
      "msg": "This mint sets a transfer limit, which cannot be enforced on a confidential transfer; set allow_confidential on the policy to permit them"
    },
    {
      "code": 6006,
      "name": "authorityBlocked",
      "msg": "The transfer authority (a delegate of the source account) is blocklisted for this mint"
    },
    {
      "code": 6007,
      "name": "invalidAuthority",
      "msg": "The new authority must be a real address and differ from the current one"
    },
    {
      "code": 6008,
      "name": "freezeAuthorityNotVigilantis",
      "msg": "The mint's freeze authority is not Vigilantis's freeze-authority address for this mint"
    },
    {
      "code": 6009,
      "name": "invalidPermissions",
      "msg": "A role needs at least one permission, and only known ones"
    },
    {
      "code": 6010,
      "name": "pauseAuthorityNotVigilantis",
      "msg": "The mint is not Pausable, or its pause authority is not Vigilantis's pause-authority address for this mint"
    },
    {
      "code": 6011,
      "name": "permanentDelegateNotVigilantis",
      "msg": "The mint's permanent delegate is not Vigilantis's permanent-delegate address for this mint"
    },
    {
      "code": 6012,
      "name": "accountNotFrozen",
      "msg": "The token account is not frozen"
    },
    {
      "code": 6013,
      "name": "nothingToSeize",
      "msg": "The token account has no public balance to seize"
    },
    {
      "code": 6014,
      "name": "seizeTooEarly",
      "msg": "The token account was frozen through Vigilantis less than 24 hours ago"
    },
    {
      "code": 6015,
      "name": "invalidCaseRef",
      "msg": "A seizure or a forfeiture needs a case reference"
    },
    {
      "code": 6016,
      "name": "invalidTokenAccount",
      "msg": "Not a token account of this mint"
    },
    {
      "code": 6017,
      "name": "notInTransfer",
      "msg": "The transfer hook was called outside a Token-2022 transfer of this mint"
    },
    {
      "code": 6018,
      "name": "ownerCanChange",
      "msg": "A token account of this mint must have an owner that cannot change (the ImmutableOwner extension, which every associated token account has)"
    },
    {
      "code": 6019,
      "name": "pausedMintHandover",
      "msg": "Resume the mint before handing on or giving up its pause authority"
    },
    {
      "code": 6020,
      "name": "accountForfeited",
      "msg": "The token account is forfeited; the admin must release the forfeiture before it can be thawed"
    }
  ],
  "types": [
    {
      "name": "allowEntry",
      "docs": [
        "An allowlist entry: its existence means `wallet` may receive `mint`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "authorityTransferCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "newAuthority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "authorityTransferProposed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "newAuthority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "authorityTransferred",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "previousAuthority",
            "type": "pubkey"
          },
          {
            "name": "newAuthority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "blockEntry",
      "docs": [
        "A blocklist entry: its existence means `wallet` may neither send nor receive `mint`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "enforcementAction",
      "docs": [
        "Emitted by `block_wallet`, `unblock_wallet`, `freeze_token_account`, `thaw_token_account`,",
        "`pause`, `resume`, `seize`, `close_seizure`, `forfeit` and `release_forfeiture`: what was done,",
        "to whom, and the issuer's reason. Vigilantis does not interpret `reason_code`;",
        "`case_ref` points to the issuer's own case file (for example a salted hash of its case number),",
        "so no personal data needs to go on-chain."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "docs": [
              "The blocked or unblocked wallet, or the owner of the frozen, thawed, seized or forfeited",
              "token account; the default address for a pause or resume."
            ],
            "type": "pubkey"
          },
          {
            "name": "tokenAccount",
            "docs": [
              "The frozen, thawed, seized or forfeited token account; the default address for a block,",
              "unblock, pause or resume."
            ],
            "type": "pubkey"
          },
          {
            "name": "action",
            "type": {
              "defined": {
                "name": "enforcementKind"
              }
            }
          },
          {
            "name": "reasonCode",
            "type": "u16"
          },
          {
            "name": "caseRef",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "authority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "enforcementKind",
      "docs": [
        "What an `EnforcementAction` did."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "block"
          },
          {
            "name": "unblock"
          },
          {
            "name": "freeze"
          },
          {
            "name": "thaw"
          },
          {
            "name": "pause"
          },
          {
            "name": "resume"
          },
          {
            "name": "seize"
          },
          {
            "name": "closeSeizure"
          },
          {
            "name": "forfeit"
          },
          {
            "name": "releaseForfeiture"
          }
        ]
      }
    },
    {
      "name": "forfeited",
      "docs": [
        "Emitted by `forfeit`, next to `EnforcementAction`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "tokenAccount",
            "type": "pubkey"
          },
          {
            "name": "reasonCode",
            "type": "u16"
          },
          {
            "name": "caseRef",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "amountCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "forfeitedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "forfeitureRecord",
      "docs": [
        "A token account frozen for good at the end of a case, because its balance (typically a",
        "confidential one) could not be seized. Written by `forfeit`, removed only by the admin's",
        "`release_forfeiture`; while it exists, `thaw_token_account` refuses the account."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "docs": [
              "The owner of the token account at the time of the forfeiture."
            ],
            "type": "pubkey"
          },
          {
            "name": "tokenAccount",
            "type": "pubkey"
          },
          {
            "name": "reasonCode",
            "type": "u16"
          },
          {
            "name": "caseRef",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "amountCommitment",
            "docs": [
              "The issuer's commitment to the amount, for example SHA-256 of a salt and the amount, or all",
              "zeros. Vigilantis does not check it."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "authority",
            "docs": [
              "Who recorded the forfeiture."
            ],
            "type": "pubkey"
          },
          {
            "name": "forfeitedAt",
            "docs": [
              "Unix time of the forfeiture."
            ],
            "type": "i64"
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "forfeitureReleased",
      "docs": [
        "Emitted by `release_forfeiture`, next to `EnforcementAction`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "tokenAccount",
            "type": "pubkey"
          },
          {
            "name": "caseRef",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "reasonCode",
            "type": "u16"
          },
          {
            "name": "authority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "freezeAuthorityChanged",
      "docs": [
        "Emitted by `set_freeze_authority` (2.3): Vigilantis handed the mint's freeze authority to",
        "`new_freeze_authority`, or gave it up (`None`). Freezes after this are no longer Vigilantis's."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "newFreezeAuthority",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "reasonCode",
            "type": "u16"
          },
          {
            "name": "caseRef",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "authority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "freezeRecord",
      "docs": [
        "When Vigilantis last froze `token_account`. Written by `freeze_token_account`, deleted by",
        "`thaw_token_account`, read by `seize`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "tokenAccount",
            "type": "pubkey"
          },
          {
            "name": "frozenAt",
            "docs": [
              "Unix time of the freeze."
            ],
            "type": "i64"
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "listEntryAdded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "list",
            "type": {
              "defined": {
                "name": "listKind"
              }
            }
          }
        ]
      }
    },
    {
      "name": "listEntryRemoved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "list",
            "type": {
              "defined": {
                "name": "listKind"
              }
            }
          }
        ]
      }
    },
    {
      "name": "listKind",
      "docs": [
        "Which list an entry belongs to."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "allow"
          },
          {
            "name": "block"
          }
        ]
      }
    },
    {
      "name": "metaListUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "entries",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "pauseAuthorityChanged",
      "docs": [
        "Emitted by `set_pause_authority`: Vigilantis handed the mint's pause authority to",
        "`new_pause_authority`, or gave it up (`None`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "newPauseAuthority",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "reasonCode",
            "type": "u16"
          },
          {
            "name": "caseRef",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "authority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "pendingAuthority",
      "docs": [
        "A proposed handover of a mint's policy authority, waiting for `new_authority` to accept."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "newAuthority",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "policyConfig",
      "docs": [
        "Per-mint compliance policy: which rules are active and their parameters."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "allowlistEnabled",
            "type": "bool"
          },
          {
            "name": "blocklistEnabled",
            "type": "bool"
          },
          {
            "name": "maxTransferAmount",
            "type": "u64"
          },
          {
            "name": "allowConfidential",
            "docs": [
              "Permit confidential transfers on a mint that also sets",
              "`max_transfer_amount`. The limit cannot be enforced on an encrypted",
              "amount, so the issuer opts in to that gap explicitly. Irrelevant when no",
              "limit is set, because there is then nothing to enforce."
            ],
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "roleEpoch",
            "docs": [
              "Increased by every `accept_authority`. A role works only while its `epoch` equals this, so",
              "a handover of the policy ends every role granted before it."
            ],
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "policyInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "allowlistEnabled",
            "type": "bool"
          },
          {
            "name": "blocklistEnabled",
            "type": "bool"
          },
          {
            "name": "maxTransferAmount",
            "type": "u64"
          },
          {
            "name": "allowConfidential",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "policyUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "allowlistEnabled",
            "type": "bool"
          },
          {
            "name": "blocklistEnabled",
            "type": "bool"
          },
          {
            "name": "maxTransferAmount",
            "type": "u64"
          },
          {
            "name": "allowConfidential",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "roleChanged",
      "docs": [
        "Emitted by `grant_role`, `update_role`, `revoke_role` and `renounce_role`. `permissions` is 0",
        "when the role is gone; `authority` is the admin, or the holder for a renounce."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "previousPermissions",
            "type": "u16"
          },
          {
            "name": "permissions",
            "type": "u16"
          },
          {
            "name": "authority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "roleEntry",
      "docs": [
        "A role: `holder` may do the actions in `permissions` (bits of [`permission`]) for `mint`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "permissions",
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "epoch",
            "docs": [
              "The policy's `role_epoch` when the role was granted or last updated. The role works only",
              "while the two are equal."
            ],
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "seized",
      "docs": [
        "Emitted by `seize`, next to `EnforcementAction`: how much public balance was burnt."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "tokenAccount",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "reasonCode",
            "type": "u16"
          },
          {
            "name": "caseRef",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "seizedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "seizureClosed",
      "docs": [
        "Emitted by `close_seizure`, next to `EnforcementAction`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "tokenAccount",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "caseRef",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "outcome",
            "type": {
              "defined": {
                "name": "seizureOutcome"
              }
            }
          },
          {
            "name": "reasonCode",
            "type": "u16"
          },
          {
            "name": "authority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "seizureOutcome",
      "docs": [
        "How a seizure ended, recorded by `close_seizure`."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "returnedToOwner"
          },
          {
            "name": "paidToVictim"
          },
          {
            "name": "paidToState"
          },
          {
            "name": "other"
          }
        ]
      }
    },
    {
      "name": "seizureRecord",
      "docs": [
        "An open seizure: `amount` of `wallet`'s public balance in `token_account` was burnt. Closed by",
        "`close_seizure` once the case is settled."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "docs": [
              "The owner of the token account at the time of the seizure."
            ],
            "type": "pubkey"
          },
          {
            "name": "tokenAccount",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "reasonCode",
            "type": "u16"
          },
          {
            "name": "caseRef",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "authority",
            "docs": [
              "Who seized."
            ],
            "type": "pubkey"
          },
          {
            "name": "seizedAt",
            "docs": [
              "Unix time of the seizure."
            ],
            "type": "i64"
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "transferRefused",
      "docs": [
        "Emitted by the hook just before it refuses a transfer. The transaction fails, but its logs",
        "(and this event) stay readable. `error_code` is the `VigilantisError` code, e.g. 6003."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "sourceOwner",
            "type": "pubkey"
          },
          {
            "name": "destinationOwner",
            "type": "pubkey"
          },
          {
            "name": "transferAuthority",
            "type": "pubkey"
          },
          {
            "name": "confidential",
            "type": "bool"
          },
          {
            "name": "errorCode",
            "type": "u32"
          }
        ]
      }
    }
  ]
};
