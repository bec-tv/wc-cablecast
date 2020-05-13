const fs = require('fs');
const fetch = require('node-fetch');
const WooCommerceRestApi = require('@woocommerce/woocommerce-rest-api').default;

let config = {
  wordpressUrl: 'http://localhost',
  wordpressPort: '8080',
  server: 'https://cablecast.bectv.org',
  location: 22,
  since: '1900-01-01T00:00:00',
  syncIndex: 0,
  numSync: 100,
  slackWebhook: null,
};

if (fs.existsSync('config.json')) {
  config = JSON.parse(fs.readFileSync('config.json'));
}

async function writeConfig() {
  return fs.promises.writeFile('config.json', JSON.stringify(config, undefined, 2));
}

const wc = new WooCommerceRestApi({
  url: config.wordpressUrl,
  port: config.wordpressPort,
  consumerKey: 'ck_fb009f23ba0d6f36b90275a02990e6c9fd288308',
  consumerSecret: 'cs_b1b1d2c489163f26d9b4217d07b8e4a8ea42f961',
  version: 'wc/v3',
});

const wcCategories = new Map();
// const wcCategories = new Map([
//   [ 8, 172 ],  [ 3, 150 ],
//   [ 9, 151 ],  [ 5, 152 ],
//   [ 11, 153 ], [ 35, 154 ],
//   [ 13, 155 ], [ 10, 156 ],
//   [ 2, 157 ],  [ 12, 158 ]
// ]);

// List of tags to sync
const tags = new Map([
  ['TJ', 'Jefferson High School'],
  ['JFK', 'Kennedy High School'],
]);

// Converts subjects to tags
const subjects = new Map([
  ['TJ', 'TJ'],
  ['JHS', 'TJ'],
  ['JFK', 'JFK'],
  ['KHS', 'JFK'],
]);

// Converts tags to WC IDs
const wcTags = new Map();

async function log(string) {
  console.log(string);

  if (config.slackWebhook) {
    try {
      await fetch(config.slackWebhook, {
        method: 'POST',
        body: JSON.stringify({ text: string }),
        headers: {
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      console.log(`Slack webhook failed ${err}`);
    }
  }
}

async function getResource(endpoint) {
  return (await fetch(`${config.server}${endpoint}?location=${config.location}`)).json();
}

async function syncCategories(categories) {
  log(`Syncing ${categories.categories.length} categories`);
  for (const category of categories.categories) {
    let isNew = false;
    let wcCategory = (await wc.get('products/categories', { slug: category.id.toString() })).data[0];
    if (!wcCategory) {
      isNew = true;
      wcCategory = {};
    }

    wcCategory.name = category.name;
    wcCategory.slug = category.id.toString();

    if (isNew) {
      wcCategory = (await wc.post('products/categories', wcCategory)).data;
    } else {
      wcCategory = (await wc.post(`products/categories/${wcCategory.id}`, wcCategory)).data;
    }

    wcCategories.set(category.id, wcCategory.id);
  }
}

async function syncTags() {
  log(`Syncing ${tags.size} tags`);
  for (const [slug, name] of tags) {
    let isNew = false;
    let wcTag = (await wc.get('products/tags', { slug })).data[0];
    if (!wcTag) {
      isNew = true;
      wcTag = {};
    }

    wcTag.slug = slug;
    wcTag.name = name;

    if (isNew) {
      wcTag = (await wc.post('products/tags', wcTag)).data;
    } else {
      wcTag = (await wc.post(`products/tags/${wcTag.id}`, wcTag)).data;
    }

    wcTags.set(slug, wcTag.id);
  }
}

async function syncShows() {
  const search = {
    savedShowSearch: {
      query: {
        groups: [
          {
            orAnd: 'and',
            filters: [
              {
                field: 'lastModified',
                operator: 'greaterThan',
                searchValue: config.since,
              },
              {
                field: 'location',
                operator: 'equals',
                searchValue: config.location,
              },
              // {
              //   field: 'id',
              //   operator: 'equals',
              //   // searchValue: '40162'
              //   // searchValue: '47440',
              // },
            ],
          },
        ],
        sortOptions: [
          {
            field: 'lastModified',
            descending: false,
          },
          {
            field: 'title',
            descending: false,
          },
        ],
      },
      name: '',
    },
  };

  const searchRes = await fetch(`${config.server}/cablecastapi/v1/shows/search/advanced`, {
    method: 'POST',
    body: JSON.stringify(search),
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const searchResult = await searchRes.json();

  if (searchResult.savedShowSearch.results.length <= config.syncIndex) {
    config.syncIndex = 0;
  }

  const ids = searchResult.savedShowSearch.results
    .slice(config.syncIndex, config.syncIndex + config.numSync);

  log(`Processing ${config.syncIndex} through ${config.syncIndex + config.numSync} out of ${searchResult.savedShowSearch.results.length} results for search`);

  let query = '?page_size=100&include=reel,media,vod,webfile';
  for (const id of ids) {
    query += `&ids[]=${id}`;
  }

  const showsRes = await fetch(`${config.server}/cablecastapi/v1/shows${query}`);

  const showsPayload = await showsRes.json();

  // console.log((await WooCommerce.get('products')).data);
  for (const show of showsPayload.shows) {
    log(`Syncing show: (${show.id}) ${show.title}`);

    let isNew = false;
    let product = (await wc.get('products', { slug: show.id.toString() })).data[0];
    if (!product) {
      isNew = true;
      product = {
        meta_data: [],
      };
    }

    product.type = 'variable';
    product.name = show.cgTitle;
    product.slug = show.id.toString();
    product.sku = show.id.toString();

    if (isNew) {
      product.attributes = [{
        name: 'Format',
        variation: true,
        options: ['DVD'],
      }];

      try {
        product = (await wc.post('products', product)).data;
      } catch (err) {
        console.log(err.response.data);
      }

      product.default_attributes = [{
        name: 'Format',
        option: 'DVD',
      }];

      await wc.post(`products/${product.id}/variations`, {
        regular_price: '25.00',
        attributes: [{
          name: 'Format',
          option: 'DVD',
        }],
      });
    }

    if (show.showThumbnailOriginal) {
      const thumbnail = showsPayload.webFiles.find((x) => x.id === show.showThumbnailOriginal);

      if (thumbnail) {
        const mediaReq = await fetch(`${config.wordpressUrl}:${config.wordpressPort}/wp-json/wp/v2/media?search=${thumbnail.name}`);
        const media = await mediaReq.json();

        if (media.length) {
          product.images = [{
            id: media[0].id,
          }];
        } else {
          product.images = [{
            name: thumbnail.name,
            src: thumbnail.url,
          }];
        }
      } else {
        log(`Error: Unable to find thumbnail ${show.showThumbnailOriginal} for show ${show.id}`);
      }
    }

    if (show.category !== null) {
      if (wcCategories.has(show.category)) {
        product.categories = [{
          id: wcCategories.get(show.category),
        }];
      } else {
        log(`Error: Unable to find WooCommerce category ${show.category} for show ${show.id}`);
      }
    } else {
      product.categories = [];
    }

    let trt = 0;
    for (const reelId of show.reels) {
      const reel = showsPayload.reels.find((x) => x.id === reelId);
      if (reel) {
        trt += reel.length;
      } else {
        log(`Error: Unable to find reel ${reelId} for show ${show.id}`);
      }
    }

    const date = new Date(0);
    date.setSeconds(trt);
    product.meta_data.push({
      key: 'cablecast_trt',
      value: date.toISOString().substr(11, 8),
    });

    product.meta_data.push({
      key: 'cablecast_event_date',
      value: show.eventDate,
    });

    product.meta_data.push({
      key: 'cablecast_last_modified',
      value: show.lastModified,
    });

    let variationUpdates = product.variations.map((id) => ({ id, status: 'publish' }));
    product.status = 'publish';
    for (const customField of show.customFields) {
      if (customField.showField === 1) {
        product.tags = [];
        if (customField.value) {
          for (let subject of customField.value.split(',')) {
            subject = subject.trim();
            const properSubject = subjects.get(subject);
            if (!properSubject) {
              log(`Error: invalid subject ${subject} on show ${show.id}`);
              continue;
            }

            const id = wcTags.get(properSubject);
            if (!id) {
              log(`Error: missing WooCommerce tag ${properSubject} for show ${show.id}`);
              continue;
            }

            product.tags.push({ id });
          }
        }
      } else if (customField.showField === 3) {
        product.meta_data.push({
          key: 'cablecast_beginning_grade',
          value: customField.value,
        });
      } else if (customField.showField === 4) {
        product.meta_data.push({
          key: 'cablecast_end_grade',
          value: customField.value,
        });
      } else if (customField.showField === 5) {
        product.meta_data.push({
          key: 'cablecast_beginning_class',
          value: customField.value,
        });
      } else if (customField.showField === 6) {
        product.meta_data.push({
          key: 'cablecast_end_class',
          value: customField.value,
        });
      } else if (customField.showField === 18) {
        if (customField.value === 7) {
          variationUpdates = product.variations.map((id) => ({ id, status: 'private' }));
        } else if (customField.value !== 8) {
          if (show.reels.length) {
            const reel = showsPayload.reels.find((x) => x.id === show.reels[0]);
            if (reel) {
              const media = showsPayload.medias.find((x) => x.id === reel.media);
              if (media) {
                if ([6, 7, 10].includes(media.disposition)) {
                  variationUpdates = product.variations.map((id) => ({ id, status: 'private' }));
                }
              } else {
                log(`Error: Unable to find media ${reel.media} for show ${show.id}`);
              }
            } else {
              log(`Error: Unable to find reel ${show.reels[0].id} for show ${show.id}`);
            }
          }
        }
      } else if (customField.showField === 19) {
        if (customField.value === 12) {
          product.status = 'private';
        } else {
          product.status = 'publish';
        }
      }
    }

    await wc.post(`products/${product.id}/variations/batch`, { update: variationUpdates });

    await wc.post(`products/${product.id}`, product);

    config.syncIndex += 1;
    if (config.syncIndex >= searchResult.savedShowSearch.results.length
        && Date.parse(show.lastModified) >= Date.parse(config.since)) {
      config.syncIndex = 0;
      config.since = show.lastModified;
    }

    await writeConfig();
  }
}

async function sync() {
  // const channels = await getResource('/cablecastapi/v1/channels');
  // const live_streams = await getResource('/cablecastapi/v1/livestreams');
  const categories = await getResource('/cablecastapi/v1/categories');
  // const producers = await getResource('/cablecastapi/v1/producers');
  // const projects = await getResource('/cablecastapi/v1/projects');
  // const show_fields = await getResource('/cablecastapi/v1/showfields');
  // const field_definitions = await getResource('/cablecastapi/v1/showfields');

  await syncCategories(categories);
  await syncTags();
  await syncShows();

  log('Finished');
}

sync();
setInterval(sync, 300000);
