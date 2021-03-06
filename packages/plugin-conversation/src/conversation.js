/**!
 *
 * Copyright (c) 2015-2016 Cisco Systems, Inc. See LICENSE file.
 * @private
 */

import {proxyEvents, tap} from '@ciscospark/common';
import {SparkPlugin} from '@ciscospark/spark-core';
import {cloneDeep, defaults, isArray, isObject, isString, last, map, merge, omit, pick, uniq} from 'lodash';
import {readExifData} from '@ciscospark/helper-image';
import uuid from 'uuid';
import querystring from 'querystring';
import ShareActivity from './share-activity';
import {EventEmitter} from 'events';

const Conversation = SparkPlugin.extend({
  namespace: `Conversation`,

  acknowledge(conversation, object, activity) {
    if (!isObject(object)) {
      return Promise.reject(new Error(`\`object\` must be an object`));
    }

    return this._inferConversationUrl(conversation)
      .then(() => this.prepare(activity, {
        verb: `acknowledge`,
        target: this.prepareConversation(conversation),
        object: {
          objectType: `activity`,
          id: object.id,
          url: object.url
        }
      }))
      .then((a) => this.submit(a));
  },

  /**
   * Adds a participant to a conversation
   * @param {Object} conversation
   * @param {Object|string} participant
   * @param {Object} activity Reference to the activity that will eventually be
   * posted. Use this to (a) pass in e.g. clientTempId and (b) render a
   * provisional activity
   * @returns {Promise<Activity>}
   */
  add(conversation, participant, activity) {
    return this._inferConversationUrl(conversation)
      .then(() => this.spark.user.asUUID(participant, {create: true}))
      .then((id) => this.prepare(activity, {
        verb: `add`,
        target: this.prepareConversation(conversation),
        object: {
          id,
          objectType: `person`
        },
        kmsMessage: {
          method: `create`,
          uri: `/authorizations`,
          resourceUri: `<KRO>`,
          userIds: [
            id
          ]
        }
      })
      .then((a) => this.submit(a)));
  },

  /**
   * Creates a conversation
   * @param {Object} params
   * @param {Array<Participant>} params.participants
   * @param {Array<File>} params.files
   * @param {string} params.comment
   * @param {Object} params.displayName
   * @param {Object} options
   * @param {Boolean} options.forceGrouped
   * @returns {Promise<Conversation>}
   */
  create(params, options) {
    if (!params.participants || params.participants.length === 0) {
      return Promise.reject(new Error(`\`params.participants\` is required`));
    }

    return Promise.all(params.participants.map((participant) => this.spark.user.asUUID(participant, {create: true})))
      .then((participants) => {
        participants.unshift(this.spark.device.userId);
        params.participants = uniq(participants);

        if (params.participants.length === 2 && !(options && options.forceGrouped)) {
          return this._maybeCreateOneOnOneThenPost(params, options);
        }

        return this._createGrouped(params);
      })
      .then((c) => {
        if (!params.files) {
          return c;
        }

        return this.spark.conversation.share(c, params.files)
          .then((a) => {
            c.activities.items.push(a);
            return c;
          });
      });
  },

  delete(conversation, object, activity) {
    if (!isObject(object)) {
      return Promise.reject(new Error(`\`object\` must be an object`));
    }

    return this._inferConversationUrl(conversation)
      .then(() => this.prepare(activity, {
        verb: `delete`,
        target: this.prepareConversation(conversation),
        object: pick(object, `id`, `url`, `objectType`)
      }))
      .then((a) => this.submit(a));
  },

  /**
   * Downloads the file specified in item.scr or item.url
   * @param {Object} item
   * @param {Object} item.scr
   * @param {string} item.url
   * @returns {Promise<File>}
   */
  download(item) {
    const isEncrypted = Boolean(item.scr);
    const shunt = new EventEmitter();
    const promise = (isEncrypted ? this.spark.encryption.download(item.scr) : this._downloadUnencryptedFile(item.url))
      .on(`progress`, (...args) => shunt.emit(`progress`, ...args))
      .then((res) => readExifData(item, res))
      .then((file) => {
        this.logger.info(`conversation: file downloaded`);

        if (item.displayName && !file.name) {
          file.name = item.displayName;
        }

        if (!file.type && item.mimeType) {
          file.type = item.mimeType;
        }

        return file;
      });

    proxyEvents(shunt, promise);

    return promise;
  },

  /**
   * Downloads an unencrypted file
   * @param {string} uri
   * @returns {Promise<File>}
   */
  _downloadUnencryptedFile(uri) {
    const options = {
      uri,
      responseType: `buffer`
    };

    const promise = this.request(options)
      .then((res) => res.body);

    proxyEvents(options.download, promise);

    return promise;
  },

  /**
   * Helper method that expands a set of parameters into an activty object
   * @param {string} verb
   * @param {Object} object
   * @param {Object} target
   * @param {Object|string} actor
   * @returns {Object}
   */
  expand(verb, object, target, actor) {
    const activity = {
      actor,
      objectType: `activity`,
      verb
    };

    if (!actor) {
      actor = this.spark.device.userId;
    }

    if (isString(actor)) {
      activity.actor = {
        objectType: `person`,
        id: actor
      };
    }

    if (object) {
      activity.object = object;
    }

    if (target) {
      activity.target = target;
    }

    return activity;
  },

  /**
   * Fetches a single conversation
   * @param {Object} conversation
   * @param {Object} options
   * @returns {Promise<Conversation>}
   */
  get(conversation, options) {
    return this._inferConversationUrl(conversation)
      .then(() => {
        const {user, url} = conversation;

        options = options || {};

        const params = {
          qs: Object.assign({
            uuidEntryFormat: true,
            personRefresh: true,
            activitiesLimit: 0,
            includeParticipants: false
          }, omit(options, `id`, `user`, `url`))
        };

        return Promise.resolve(user ? this.spark.user.asUUID(user) : null)
          .then((userId) => {
            if (userId) {
              Object.assign(params, {
                service: `conversation`,
                resource: `conversations/user/${userId}`
              });
            }
            else {
              params.uri = url;
            }
            return this.request(params);
          });
      })
      .then(tap((res) => this._recordUUIDs(res.body)))
      .then((res) => res.body);
  },

  /**
   * Leaves the conversation or removes the specified user from the specified
   * conversation
   * @param {Object} conversation
   * @param {Object|string} participant If not specified, defaults to current
   * user
   * @param {Object} activity Reference to the activity that will eventually be
   * posted. Use this to (a) pass in e.g. clientTempId and (b) render a
   * provisional activity
   * @returns {Promise<Activity>}
   */
  leave(conversation, participant, activity) {
    return this._inferConversationUrl(conversation)
      .then(() => {
        if (!participant) {
          participant = this.spark.device.userId;
        }

        return this.spark.user.asUUID(participant)
          .then((id) => this.prepare(activity, {
            verb: `leave`,
            target: this.prepareConversation(conversation),
            object: {
              id,
              objectType: `person`
            },
            kmsMessage: {
              method: `delete`,
              uri: `<KRO>/authorizations?${querystring.stringify({authId: id})}`
            }
          }));
      })
      .then((a) => this.submit(a));
  },

  /**
   * Lists a set of conversations. By default does not fetch activities or
   * participants
   * @param {Object} options
   * @returns {Promise<Array<Conversation>>}
   */
  list(options) {
    return this._list({
      service: `conversation`,
      resource: `conversations`,
      qs: options
    });
  },

  /**
   * Lists the conversations the current user has left. By default does not
   * fetch activities or participants
   * @param {Object} options
   * @returns {Promise<Array<Conversation>>}
   */
  listLeft(options) {
    return this._list({
      service: `conversation`,
      resource: `conversations/left`,
      qs: options
    });
  },

  /**
   * List activities for the specified conversation
   * @param {Object} options
   * @returns {Promise<Array<Activity>>}
   */
  listActivities(options) {
    return this._listActivities(Object.assign(options, {mentions: false}));
  },

  /**
   * Lists activities in which the current user was mentioned
   * @param {Object} options
   * @returns {Promise<Array<Activity>>}
   */
  listMentions(options) {
    return this._listActivities(Object.assign(options, {mentions: true}));
  },

  /**
   * Mutes the mentions of a conversation
   * @param {Conversation~ConversationObject} conversation
   * @param {Conversation~ActivityObject} activity
   * @returns {Promise} Resolves with the created activity
   */
  muteMentions(conversation, activity) {
    return this.tag(conversation, {
      tags: [`MENTION_NOTIFICATIONS_OFF`]
    }, activity);
  },

  /**
   * Mutes the messages of a conversation
   * @param {Conversation~ConversationObject} conversation
   * @param {Conversation~ActivityObject} activity
   * @returns {Promise} Resolves with the created activity
   */
  muteMessages(conversation, activity) {
    return this.tag(conversation, {
      tags: [`MESSAGE_NOTIFICATIONS_OFF`]
    }, activity);
  },

  /**
   * Posts a message to a conversation
   * @param {Object} conversation
   * @param {Object|string} message if string, treated as plaintext; if object,
   * assumed to be object property of `post` activity
   * @param {Object} activity Reference to the activity that will eventually be
   * posted. Use this to (a) pass in e.g. clientTempId and (b) render a
   * provisional activity
   * @returns {Promise<Activity>}
   */
  post(conversation, message, activity) {
    if (isString(message)) {
      message = {
        displayName: message
      };
    }

    return this._inferConversationUrl(conversation)
      .then(() => this.prepare(activity, {
        verb: `post`,
        target: this.prepareConversation(conversation),
        object: Object.assign({objectType: `comment`}, message)
      }))
      .then((a) => this.submit(a));
  },

  prepareConversation(conversation) {
    return defaults(pick(conversation, `id`, `url`, `objectType`, `defaultActivityEncryptionKeyUrl`, `kmsResourceObjectUrl`), {
      objectType: `conversation`
    });
  },

  prepare(activity, params) {
    params = params || {};
    activity = activity || {};
    return Promise.resolve(activity.prepare ? activity.prepare(params) : activity)
      .then((act) => {
        defaults(act, {
          verb: params.verb,
          kmsMessage: params.kmsMessage,
          objectType: `activity`,
          clientTempId: uuid.v4(),
          actor: this.spark.device.userId
        });

        if (isString(act.actor)) {
          act.actor = {
            objectType: `person`,
            id: act.actor
          };
        }

        [`actor`, `object`].forEach((key) => {
          if (params[key]) {
            act[key] = act[key] || {};
            defaults(act[key], params[key]);
          }
        });

        if (params.target) {
          merge(act, {
            target: pick(params.target, `id`, `url`, `objectType`, `kmsResourceObjectUrl`, `defaultActivityEncryptionKeyUrl`)
          });
        }

        [`object`, `target`].forEach((key) => {
          if (act[key] && act[key].url && !act[key].id) {
            act[key].id = act[key].url.split(`/`).pop();
          }
        });

        [`actor`, `object`, `target`].forEach((key) => {
          if (act[key] && !act[key].objectType) {
            // Reminder: throwing here because it's the only way to get out of
            // this loop in event of an error.
            throw new Error(`\`act.${key}.objectType\` must be defined`);
          }
        });

        if (act.object && act.object.content && !act.object.displayName) {
          return Promise.reject(new Error(`Cannot submit activity object with \`content\` but no \`displayName\``));
        }

        return act;
      });
  },

  /**
   * Handles incoming conversatin.activity mercury messages
   * @param {Event} event
   * @returns {Promise}
   */
  processActivityEvent(event) {
    return this.spark.transform(`inbound`, event)
      .then(() => event);
  },

  /**
   * Removes all mute-related tags
   * @param {Conversation~ConversationObject} conversation
   * @param {Conversation~ActivityObject} activity
   * @returns {Promise} Resolves with the created activity
   */
  removeAllMuteTags(conversation, activity) {
    return this.untag(conversation, {
      tags: [
        `MENTION_NOTIFICATIONS_OFF`,
        `MENTION_NOTIFICATIONS_ON`,
        `MESSAGE_NOTIFICATIONS_OFF`,
        `MESSAGE_NOTIFICATIONS_ON`
      ]
    }, activity);
  },

  /**
   * Creates a ShareActivty for the specified conversation
   * @param {Object} conversation
   * @returns {ShareActivty}
   */
  makeShare(conversation) {
    return ShareActivity.create(conversation, null, this.spark);
  },

  /**
   * Assigns an avatar to a room
   * @param {Object} conversation
   * @param {File} avatar
   * @returns {Promise<Activity>}
   */
  assign(conversation, avatar) {
    if ((avatar.size || avatar.length) > 1024 * 1024) {
      return Promise.reject(new Error(`Room avatars must be less than 1MB`));
    }
    return this._inferConversationUrl(conversation)
      .then(() => {
        const activity = ShareActivity.create(conversation, null, this.spark);
        activity.enableThumbnails = false;
        activity.add(avatar);

        return this.prepare(activity, {
          target: this.prepareConversation(conversation)
        });
      })
      .then((a) => {
        // yes, this seems a little hacky; will likely be resolved as a result
        // of #213
        a.verb = `assign`;
        return this.submit(a);
      });
  },

  /**
   * Sets the typing status of the current user in a conversation
   *
   * @param {Object} conversation
   * @param {Object} options
   * @param {boolean} options.typing
   * @returns {Promise}
   */
  updateTypingStatus(conversation, options) {
    if (!conversation.id) {
      if (conversation.url) {
        conversation.id = conversation.url.split(`/`).pop();
      }
      else {
        return Promise.reject(new Error(`conversation: could not identify conversation`));
      }
    }

    let eventType;
    if (options.typing) {
      eventType = `status.start_typing`;
    }
    else {
      eventType = `status.stop_typing`;
    }

    const params = {
      method: `POST`,
      service: `conversation`,
      resource: `status/typing`,
      body: {
        conversationId: conversation.id,
        eventType
      }
    };
    return this.request(params);
  },

  /**
   * Shares files to the specified converstion
   * @param {Object} conversation
   * @param {ShareActivity|Array<File>} activity
   * @returns {Promise<Activity>}
   */
  share(conversation, activity) {
    if (isArray(activity)) {
      activity = {
        object: {
          files: activity
        }
      };
    }

    return this._inferConversationUrl(conversation)
      .then(() => {
        if (!(activity instanceof ShareActivity)) {
          activity = ShareActivity.create(conversation, activity, this.spark);
        }

        return this.prepare(activity, {
          target: this.prepareConversation(conversation)
        });
      })
      .then((a) => this.submit(a));
  },

  /**
   * Submits an activity to the conversation service
   * @param {Object} activity
   * @returns {Promise<Activity>}
   */
  submit(activity) {
    const params = {
      method: `POST`,
      service: `conversation`,
      resource: activity.verb === `share` ? `content` : `activities`,
      body: activity,
      qs: {
        personRefresh: true
      }
    };

    if (activity.verb === `share`) {
      Object.assign(params.qs, {
        transcode: true,
        async: false
      });
    }

    // leaky abstraction
    if (activity.verb !== `acknowledge`) {
      this.spark.trigger(`user-activity`);
    }

    return this.request(params)
      .then((res) => res.body);
  },

  /**
   * Remove the avatar from a room
   * @param {Conversation~ConversationObject} conversation
   * @param {Conversation~ActivityObject} activity
   * @returns {Promise}
   */
  unassign(conversation, activity) {
    return this._inferConversationUrl(conversation)
      .then(() => this.prepare(activity, {
        verb: `unassign`,
        target: this.prepareConversation(conversation),
        object: {
          objectType: `content`,
          files: {
            items: []
          }
        }
      }))
      .then((a) => this.submit(a));
  },

  /**
   * Mutes the mentions of a conversation
   * @param {Conversation~ConversationObject} conversation
   * @param {Conversation~ActivityObject} activity
   * @returns {Promise} Resolves with the created activity
   */
  unmuteMentions(conversation, activity) {
    return this.tag(conversation, {
      tags: [`MENTION_NOTIFICATIONS_ON`]
    }, activity);
  },

  /**
   * Mutes the messages of a conversation
   * @param {Conversation~ConversationObject} conversation
   * @param {Conversation~ActivityObject} activity
   * @returns {Promise} Resolves with the created activity
   */
  unmuteMessages(conversation, activity) {
    return this.tag(conversation, {
      tags: [`MESSAGE_NOTIFICATIONS_ON`]
    }, activity);
  },

  update(conversation, object, activity) {
    if (!isObject(object)) {
      return Promise.reject(new Error(`\`object\` must be an object`));
    }

    return this._inferConversationUrl(conversation)
      .then(() => this.prepare(activity, {
        verb: `update`,
        target: this.prepareConversation(conversation),
        object
      }))
      .then((a) => this.submit(a));
  },

  /**
   * Sets a new key for the conversation
   * @param {Object} conversation
   * @param {Key|string} key (optional)
   * @param {Object} activity Reference to the activity that will eventually be
   * posted. Use this to (a) pass in e.g. clientTempId and (b) render a
   * provisional activity
   * @returns {Promise<Activity>}
   */
  updateKey(conversation, key, activity) {
    return this._inferConversationUrl(conversation)
      .then(() => this.get(conversation, {
        activitiesLimit: 0,
        includeParticipants: true
      }))
      .then((c) => this._updateKey(c, key, activity));
  },

  /**
   * Sets a new key for the conversation
   * @param {Object} conversation
   * @param {Key|string} key (optional)
   * @param {Object} activity Reference to the activity that will eventually be
   * posted. Use this to (a) pass in e.g. clientTempId and (b) render a
   * provisional activity
   * @private
   * @returns {Promise<Activity>}
   */
  _updateKey(conversation, key, activity) {
    return Promise.resolve(key || this.spark.encryption.kms.createUnboundKeys({count: 1}))
      .then((keys) => {
        const k = isArray(keys) ? keys[0] : keys;
        const params = {
          verb: `updateKey`,
          target: this.prepareConversation(conversation),
          object: {
            defaultActivityEncryptionKeyUrl: k.uri,
            objectType: `conversation`
          }
        };

        // Reminder: the kmsResourceObjectUrl is only usable if there is
        // defaultActivityEncryptionKeyUrl.
        if (conversation.defaultActivityEncryptionKeyUrl) {
          params.kmsMessage = {
            method: `update`,
            resourceUri: `<KRO>`,
            uri: k.uri
          };
        }
        else {
          params.kmsMessage = {
            method: `create`,
            uri: `/resources`,
            userIds: map(conversation.participants.items, `id`),
            keyUris: [
              k.uri
            ]
          };
        }

        return this.prepare(activity, params)
          .then((a) => this.submit(a));
      });
  },

  /**
   * @param {Object} payload
   * @private
   * @returns {Promise<Activity>}
   */
  _create(payload) {
    return this.request({
      method: `POST`,
      service: `conversation`,
      resource: `conversations`,
      body: payload
    })
      .then((res) => res.body);
  },

  /**
   * @param {Object} params
   * @private
   * @returns {Promise}
   */
  _createGrouped(params) {
    return this._create(this._prepareConversationForCreation(params));
  },

  /**
   * @param {Object} conversation
   * @private
   * @returns {Promise}
   */
  _inferConversationUrl(conversation) {
    if (!conversation.url && conversation.id) {
      return this.spark.device.getServiceUrl(`conversation`)
        .then((url) => {
          conversation.url = `${url}/conversations/${conversation.id}`;
          /* istanbul ignore else */
          if (process.env.NODE_ENV !== `production`) {
            this.logger.warn(`conversation: inferred conversation url from conversation id; please pass whole conversation objects to Conversation methods`);
          }
          return conversation;
        });
    }

    return Promise.resolve(conversation);
  },

  /**
   * @param {Object} options
   * @private
   * @returns {Promise<Array<Activity>>}
   */
  _listActivities(options) {
    return this._list({
      service: `conversation`,
      resource: options.mentions ? `mentions` : `activities`,
      qs: omit(options, `mentions`)
    });
  },

  /**
   * @param {Object} options
   * @private
   * @returns {Promise<Array<Conversation>>}
   */
  _list(options) {
    options.qs = Object.assign({
      personRefresh: true,
      uuidEntryFormat: true,
      activitiesLimit: 0,
      participantsLimit: 0
    }, options.qs);

    return this.request(options)
      .then((res) => {
        if (!res.body || !res.body.items || res.body.items.length === 0) {
          return [];
        }

        const items = res.body.items;
        if (last(items).published < items[0].published) {
          items.reverse();
        }

        return Promise.all(items.map((item) => this._recordUUIDs(item)))
          // eslint-disable-next-line max-nested-callbacks
          .then(() => items);
      });
  },

  /**
   * @param {Object} params
   * @param {Object} options
   * @private
   * @returns {Promise<Conversation>}
   */
  _maybeCreateOneOnOneThenPost(params, options) {
    return this.get(defaults({
      // the use of uniq in Conversation#create guarantees participant[1] will
      // always be the other user
      user: params.participants[1]
    }), options)
      .then((conversation) => {
        if (params.comment) {
          return this.post(conversation, {displayName: params.comment})
            .then((activity) => {
              conversation.activities.push(activity);
              return conversation;
            });
        }

        return conversation;
      })
      .catch((reason) => {
        if (reason.statusCode !== 404) {
          return Promise.reject(reason);
        }

        const payload = this._prepareConversationForCreation(params);
        payload.tags = [`ONE_ON_ONE`];
        return this._create(payload);
      });
  },

  /**
   * @param {Object} params
   * @private
   * @returns {Object}
   */
  _prepareConversationForCreation(params) {
    const payload = {
      activities: {
        items: [
          this.expand(`create`)
        ]
      },
      objectType: `conversation`,
      kmsMessage: {
        method: `create`,
        uri: `/resources`,
        userIds: cloneDeep(params.participants),
        keyUris: []
      }
    };

    if (params.displayName) {
      payload.displayName = params.displayName;
    }

    params.participants.forEach((participant) => {
      payload.activities.items.push(this.expand(`add`, {
        objectType: `person`,
        id: participant
      }));
    });

    if (params.comment) {
      payload.activities.items.push(this.expand(`post`, {
        objectType: `comment`,
        displayName: params.comment
      }));
    }

    return payload;
  },

  /**
   * @param {Object} conversation
   * @private
   * @returns {Promise}
   */
  _recordUUIDs(conversation) {
    if (!conversation.participants || !conversation.participants.items) {
      return Promise.resolve(conversation);
    }

    return Promise.all(conversation.participants.items.map((participant) => this.spark.user.recordUUID(participant)));
  }
});

[
  `favorite`,
  `hide`,
  `lock`,
  `mute`,
  `unfavorite`,
  `unhide`,
  `unlock`,
  `unmute`
].forEach((verb) => {
  Conversation.prototype[verb] = function submitSimpleActivity(conversation, activity) {
    return this._inferConversationUrl(conversation)
      .then(() => this.prepare(activity, {
        verb,
        object: this.prepareConversation(conversation)
      }))
      .then((a) => this.submit(a));
  };
});

[
  `assignModerator`,
  `unassignModerator`
].forEach((verb) => {
  Conversation.prototype[verb] = function submitModerationChangeActivity(conversation, moderator, activity) {
    return Promise.all([
      this._inferConversationUrl(conversation),
      moderator ? this.spark.user.asUUID(moderator) : this.spark.device.userId
    ])
      .then(([c, userId]) => this.prepare(activity, {
        verb,
        target: this.prepareConversation(c),
        object: {
          id: userId,
          objectType: `person`
        }
      }))
      .then((a) => this.submit(a));
  };
});

[
  `tag`,
  `untag`
].forEach((verb) => {
  Conversation.prototype[verb] = function submitObjectActivity(conversation, object, activity) {
    if (!isObject(object)) {
      return Promise.reject(new Error(`\`object\` must be an object`));
    }

    const c = this.prepareConversation(conversation);

    return this._inferConversationUrl(conversation)
      .then(() => this.prepare(activity, {
        verb,
        target: c,
        object: Object.assign(c, object)
      }))
      .then((a) => this.submit(a));
  };
});

export default Conversation;
