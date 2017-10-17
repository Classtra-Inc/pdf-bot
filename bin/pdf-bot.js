#!/usr/bin/env node

var fs = require('fs')
var path = require('path')
var debug = require('debug')('pdf:cli')
var Table = require('cli-table')
var program = require('commander');
var merge = require('lodash.merge')
var chunk = require('lodash.chunk')
var createPdfGenerator = require('../src/pdfGenerator')
var createApi = require('../src/api')
var error = require('../src/error')
var createQueue = require('../src/queue')
var webhook = require('../src/webhook')
var pjson = require('../package.json')
var execSync = require('child_process').execSync
var prompt = require('prompt')

program
  .version(pjson.version)
  .option('-c, --config <path>', 'Path to configuration file')

var decaySchedule = [
  1000 * 60, // 1 minute
  1000 * 60 * 3, // 3 minutes
  1000 * 60 * 10, // 10 minutes
  1000 * 60 * 30, // 30 minutes
  1000 * 60 * 60 // 1 hour
];

var configuration, queue
var defaultConfig = {
  api: {
    port: 3000,
    //token: 'api-token'
  },
  // html-pdf-chrome options
  generator: {

  },
  queue: {
    generationRetryStrategy: function(job, retries) {
      return decaySchedule[retries - 1] ? decaySchedule[retries - 1] : 0
    },
    generationMaxTries: 5,
    parallelism: 4,
    webhookRetryStrategy: function(job, retries) {
      return decaySchedule[retries - 1] ? decaySchedule[retries - 1] : 0
    },
    webhookMaxTries: 5,
    lowDbOptions: {

    }
  },
  storage: {
    /*
    's3': createS3Config({
      bucket: '',
      accessKeyId: '',
      region: '',
      secretAccessKey: ''
    })
    */
  },
  storagePath: 'storage',
  /*webhook: {
    headerNamespace: 'X-PDF-',
    requestOptions: {

    },
    secret: '12345',
    url: 'http://localhost:3001/hook'
  }*/
}

program
  .command('api')
  .description('Start the API')
  .action(function (options) {
    // We delay initiation of queue. This is because the API will load the DB in memory as
    // copy A. When we make changes through the CLI this creates copy B. But next time the
    // user pushes to the queue using the API copy A will be persisted again.
    var initiateQueue = openConfig(true)

    var apiOptions = configuration.api
    var port = apiOptions.port

    createApi(initiateQueue, {
      port: port,
      token: apiOptions.token
    }).listen(port, function() {
      debug('Listening to port %d', port)
    })
  })

program
  .command('install')
  .action(function (options) {
    var configPath = program.config || path.join(process.cwd(), 'pdf-bot.config.js')

    function startPrompt() {
      prompt.start({noHandleSIGINT: true})
      prompt.get([
      {
        name: 'storagePath',
        description: 'Enter a path for storage',
        default: path.join(process.cwd(), 'pdf-storage'),
        required: true
      },
      {
        name: 'token',
        description: 'An access token for your API',
        required: false
      }], function (err, result) {
        if (err) {
          process.exit(0)
        }
        var options = {}

        if (result.token) {
          options.api = {token: result.token}
        }

        options.storagePath = result.storagePath

        var configContents = "module.exports = " + JSON.stringify(options, null, 2)

        fs.writeFileSync(configPath, configContents)

        if (!fs.existsSync(options.storagePath)) {
          fs.mkdirSync(options.storagePath, '0775')
          fs.mkdirSync(path.join(options.storagePath, 'db'), '0775')
          fs.mkdirSync(path.join(options.storagePath, 'pdf'), '0775')
        }

        console.log('pdf-bot was installed successfully.')
        console.log('Config file is placed at ' + configPath + ' and contains')
        console.log(configContents)
        console.log('You should add ALIAS pdf-bot="pdf-bot -c ' + configPath + '" to your ~/.profile')
      });
    }

    var existingConfigFileFound = fs.existsSync(configPath)
    if (existingConfigFileFound) {
      prompt.start({noHandleSIGINT: true})
      prompt.get([
        {
          name: 'replaceConfig',
          description: 'A config file already exists, are you sure you want to override (yes/no)'
        }
      ], function (err, result) {
        if (err) {
          process.exit(0)
        }
        if (result.replaceConfig !== 'yes') {
          process.exit(0)
        } else {
          startPrompt()
        }
      })
    } else {
      startPrompt()
    }
  })

program
  .command('generate [jobID]')
  .description('Generate PDF for job')
  .action(function (jobId, options){
    openConfig()

    var job = queue.getById(jobId)

    if (!job) {
      console.log('Job not found')
      return;
    }

    processJob(job, configuration)
  })

program
  .command('jobs')
  .description('List all completed jobs')
  .option('--completed', 'Show completed jobs')
  .option('--failed', 'Show failed jobs')
  .option('-l, --limit [limit]', 'Limit how many jobs to show')
  .action(function (options) {
    openConfig()

    listJobs(queue, options.failed, options.completed, options.limit)
  })

program
  .command('ping [jobID]')
  .description('Attempt to ping webhook for job')
  .action(function (jobId, options) {
    openConfig()

    var job = queue.getById(jobId)

    if (!job) {
      console.log('Job not found.')
      return;
    }

    ping(job, configuration.webhook)
  })

program
  .command('ping:retry-failed')
  .action(function() {
    openConfig()

    var maxTries = configuration.queue.webhookMaxTries
    var retryStrategy = configuration.queue.webhookRetryStrategy

    var next = queue.getNextWithoutSuccessfulPing(retryStrategy, maxTries)

    if (next) {
      ping(next, configuration.webhook)
    }
  })

program
  .command('pings [jobId]')
  .description('List pings for a job')
  .action(function (jobId, options) {
    openConfig()

    var job = queue.getById(jobId)

    if (!job) {
      console.log('Job not found')
      return;
    }

    var table = new Table({
      head: ['ID', 'URL', 'Method', 'Status', 'Sent at', 'Response', 'Payload'],
      colWidths: [40, 40, 50, 20, 20, 20]
    });

    for(var i in job.pings) {
      var ping = job.pings[i]

      table.push([
        ping.id,
        ping.url,
        ping.method,
        ping.status,
        formatDate(ping.sent_at),
        JSON.stringify(ping.response),
        JSON.stringify(ping.payload)
      ])
    }

    console.log(table.toString())
  })

program
  .command('purge')
  .description('Will remove all completed jobs')
  .option('--failed', 'Remove all failed jobs')
  .option('--new', 'Remove all new jobs')
  .action(function (options) {
    openConfig()

    queue.purge(options.failed, options.new)

    console.log('The queue was purged.')
  })

program
  .command('push [url]')
  .description('Push new job to the queue')
  .option('-m, --meta [meta]', 'JSON string with meta data. Default: \'{}\'')
  .action(function (url, options) {
    openConfig()

    var response = queue.addToQueue({
      url: url,
      meta: JSON.parse(options.meta || '{}')
    })

    if (error.isError(response)) {
      console.error('Could not push to queue: %s', response.message)
      process.exit(1)
    }
  })

program
  .command('shift')
  .description('Run the next job in the queue')
  .action(function (url) {
    openConfig()

    var maxTries = configuration.queue.generationMaxTries
    var retryStrategy = configuration.queue.generationRetryStrategy

    var next = queue.getNext(retryStrategy, maxTries)

    if (next) {
      processJob(next, configuration)
    }
  })

program
  .command('shift:all')
  .description('Run all unfinished jobs in the queue')
  .action(function (url) {
    openConfig()

    var isBusy = queue.isBusy()
    if (isBusy) {
      return
    }

    var maxTries = configuration.queue.generationMaxTries
    var retryStrategy = configuration.queue.generationRetryStrategy
    var parallelism = configuration.queue.parallelism

    var jobs = queue.getAllUnfinished(retryStrategy, maxTries)

    if (jobs.length > 0) {
      var chunks = chunk(jobs, parallelism)

      function runNextChunk(k = 1) {
        if (chunks.length === 0) {
          queue.setIsBusy(false)
          process.exit(0)
        } else {
          var chunk = chunks.shift()
          console.log('Running chunk %s, %s chunks left', k, chunks.length)

          var promises = []
          for(var i in chunk) {
            promises.push(processJob(chunk[i], configuration, false))
          }

          Promise.all(promises)
            .then(function(){
              runNextChunk(k + 1)
            })
            .catch(function(){
              queue.setIsBusy(false)
              process.exit(1)
            })
        }
      }

      console.log('Found %s jobs, divided into %s chunks', jobs.length, chunks.length)

      queue.setIsBusy(true)

      runNextChunk()
    }
  })

program.parse(process.argv)

if (!process.argv.slice(2).length) {
  program.outputHelp();
}

function processJob(job, configuration, exitProcess = true) {
  var generatorOptions = configuration.generator
  var storagePlugins = configuration.storage

  var generator = createPdfGenerator(configuration.storagePath, generatorOptions, storagePlugins)

  return queue.processJob(generator, job, configuration.webhook).then(response => {
    if (error.isError(response)) {
      console.error(response.message)
      if (exitProcess) {
        process.exit(1)
      }
    } else {
      console.log('Job ID ' + job.id + ' was processed.')
      if (exitProcess) {
        process.exit(0)
      }
    }
  })
}

function openConfig(delayQueueCreation = false) {
  configuration = defaultConfig

  if (!program.config) {
    if (fs.existsSync(path.join(process.cwd(), 'pdf-bot.config.js'))) {
      program.config = 'pdf-bot.config.js'
    } else {
      throw new Error('You need to supply a config file')
    }
  }

  var configPath = path.join(process.cwd(), program.config)

  if (!fs.existsSync(configPath)) {
    throw new Error('No config file was found at ' + configPath)
  }

  debug('Creating CLI using config file %s', configPath)
  merge(configuration, require(configPath))

  if (!fs.existsSync(configuration.storagePath)) {
    throw new Error('Whoops! Looks like your storage folder does not exist. You should run pdf-bot install.')
  }

  if (!fs.existsSync(path.join(configuration.storagePath, 'db'))) {
    throw new Error('There is no database folder in the storage folder. Create it: storage/db')
  }

  if (!fs.existsSync(path.join(configuration.storagePath, 'pdf'))) {
    throw new Error('There is no pdf folder in the storage folder. Create it: storage/pdf')
  }

  function initiateQueue() {
    var queueOptions = configuration.queue
    return createQueue(path.join(configuration.storagePath, 'db/db.json'), queueOptions.lowDbOptions)
  }

  if (delayQueueCreation) {
    return initiateQueue
  } else {
    queue = initiateQueue()
  }
}

function listJobs(queue, failed = false, limit) {
  var response = queue.getList(
    failed,
    limit
  )

  var table = new Table({
    head: ['ID', 'URL', 'Meta', 'PDF Gen. tries', 'Created at', 'Completed at'],
    colWidths: [40, 40, 50, 20, 20, 20]
  });

  for(var i in response) {
    var job = response[i]

    table.push([
      job.id,
      job.url,
      JSON.stringify(job.meta),
      job.generations.length,
      formatDate(job.created_at),
      formatDate(job.completed_at)
    ])
  }

  console.log(table.toString());
}

function ping(job, webhookConfiguration) {
  queue.attemptPing(job, webhookConfiguration || {}).then(response => {
    if (!response.error) {
      console.log('Ping succeeded: ' + JSON.stringify(response))
    } else {
      console.error('Ping failed: ' + JSON.stringify(response))
    }

    return response
  })
}

function formatDate(input) {
  if (!input) {
    return ''
  }

  return (new Date(input)).toLocaleString()
}
