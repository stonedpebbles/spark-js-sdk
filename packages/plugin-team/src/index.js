/**!
 *
 * Copyright (c) 2015-2016 Cisco Systems, Inc. See LICENSE file.
 * @private
 */

import {isArray} from 'lodash';
import {registerPlugin} from '@ciscospark/spark-core';
import Team from './team';
import config from './config';

import '@ciscospark/plugin-conversation';
import '@ciscospark/plugin-user';
import '@ciscospark/plugin-encryption';

registerPlugin(`team`, Team, {
  payloadTransformer: {
    predicates: [],
    transforms: [
      {
        name: `decryptTeam`,
        direction: `inbound`,
        fn(ctx, key, team) {
          const promises = [];

          if (team.conversations.items) {
            promises.push(Promise.all(team.conversations.items.map((item) => ctx.transform(`decryptObject`, null, item))));
          }

          const usableKey = team.encryptionKeyUrl || key;

          if (usableKey) {
            promises.push(ctx.transform(`decryptPropDisplayName`, usableKey, team));
            promises.push(ctx.transform(`decryptPropSummary`, usableKey, team));
          }

          return Promise.all(promises);
        }
      },
      {
        name: `decryptPropSummary`,
        direction: `inbound`,
        fn(ctx, key, team) {
          return ctx.transform(`decryptTextProp`, `summary`, key, team);
        }
      },
      {
        name: `encryptTeam`,
        direction: `outbound`,
        fn(ctx, key, team) {
          if (key === false) {
            return Promise.resolve();
          }

          return Promise.resolve(key || ctx.spark.encryption.kms.createUnboundKeys({count: 1}))
            .then((keys) => {
              const k = isArray(keys) ? keys[0] : keys;

              if (team.kmsMessage && team.kmsMessage.keyUris && !team.kmsMessage.keyUris.includes(k.uri)) {
                team.kmsMessage.keyUris.push(k.uri);
              }

              return Promise.all([
                ctx.transform(`encryptPropDisplayName`, k, team),
                ctx.transform(`encryptPropSummary`, k, team)
              ])
                .then(() => {
                  team.encryptionKeyUrl = k.uri || k;

                  // we only want to set the defaultActivityEncryptionKeyUrl if we've
                  // bound a new key
                  if (!key) {
                    team.defaultActivityEncryptionKeyUrl = team.defaultActivityEncryptionKeyUrl || k.uri || k;
                  }
                });
            });
        }
      },
      {
        name: `encryptPropSummary`,
        direction: `outbound`,
        fn(ctx, key, team) {
          return ctx.transform(`encryptTextProp`, `summary`, key, team);
        }
      },
      {
        name: `normalizeTeam`,
        fn(ctx, team) {
          team.conversations = team.conversations || {};
          team.conversations.items = team.conversations.items || [];
          team.teamMembers = team.teamMembers || {};
          team.teamMembers.items = team.teamMembers.items || [];

          return Promise.all([
            Promise.all(team.conversations.items.map((item) => ctx.transform(`normalizeObject`, item))),
            Promise.all(team.teamMembers.items.map((item) => ctx.transform(`normalizeObject`, item)))
          ]);
        }
      }
    ]
  },
  config
});

export {default as default} from './team';
