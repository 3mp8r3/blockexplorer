require( '../db.js' );

var express = require('express');
var app = express();

var fs = require('fs');

var Web3 = require('web3');

var mongoose = require( 'mongoose' );
var Block     = mongoose.model( 'Block' );

var grabBlocks = function(config) {
    var web3 = new Web3(new Web3.providers.HttpProvider('http://localhost:' + 
        config.gethPort.toString()));


    if('listenOnly' in config && config.listenOnly === true) 
        listenBlocks(config, web3);
    else
        setTimeout(function() {
            grabBlock(config, web3, config.blocks.pop());
        }, 2000);

}

var listenBlocks = function(config, web3) {
    var newBlocks = web3.eth.filter("latest");
    newBlocks.watch(function (error, log) {

        if(error) {
            console.log('Error: ' + error);
        } else if (log == null) {
            console.log('Warning: null block hash');
        } else {
            grabBlock(config, web3, log);
        }

    });
}

var grabBlock = function(config, web3, blockHashOrNumber) {
    var desiredBlockHashOrNumber;

    // check if done
    if(blockHashOrNumber == undefined) {
        return; 
    }

    if (typeof blockHashOrNumber === 'object') {
        if('start' in blockHashOrNumber && 'end' in blockHashOrNumber) {
            desiredBlockHashOrNumber = blockHashOrNumber.end;
        }
        else {
            console.log('Error: Aborted becasue found a interval in blocks ' +
                'array that doesn\'t have both a start and end.');
            process.exit(9);
        }
    }
    else {
        desiredBlockHashOrNumber = blockHashOrNumber;
    }

    if(web3.isConnected()) {

        web3.eth.getBlock(desiredBlockHashOrNumber, true, function(error, blockData) {
            if(error) {
                console.log('Warning: error on getting block with hash/number: ' +
                    desiredBlockHashOrNumber + ': ' + error);
            }
            else if(blockData == null) {
                console.log('Warning: null block data received from the block with hash/number: ' +
                    desiredBlockHashOrNumber);
            }
            else {
                if('terminateAtExistingDB' in config && config.terminateAtExistingDB === true) {
                    checkBlockDBExistsThenWrite(config, blockData);
                }
                else {
                    writeBlockToDB(config, blockData);
                }
                if('listenOnly' in config && config.listenOnly === true) 
                    return;

                if('hash' in blockData && 'number' in blockData) {
                    // If currently working on an interval (typeof blockHashOrNumber === 'object') and 
                    // the block number or block hash just grabbed isn't equal to the start yet: 
                    // then grab the parent block number (<this block's number> - 1). Otherwise done 
                    // with this interval object (or not currently working on an interval) 
                    // -> so move onto the next thing in the blocks array.
                    if(typeof blockHashOrNumber === 'object' &&
                        (
                            (typeof blockHashOrNumber['start'] === 'string' && blockData['hash'] !== blockHashOrNumber['start']) ||
                            (typeof blockHashOrNumber['start'] === 'number' && blockData['number'] > blockHashOrNumber['start'])
                        )
                    ) {
                        blockHashOrNumber['end'] = blockData['number'] - 1;
                        grabBlock(config, web3, blockHashOrNumber);
                    }
                    else {
                        grabBlock(config, web3, config.blocks.pop());
                    }
                }
                else {
                    console.log('Error: No hash or number was found for block: ' + blockHashOrNumber);
                    process.exit(9);
                }
            }
        });
    }
    else {
        console.log('Error: Aborted due to web3 is not connected when trying to ' +
            'get block ' + desiredBlockHashOrNumber);
        process.exit(9);
    }
}


var writeBlockToDB = function(config, blockData) {
    //var blockContents = JSON.stringify(blockData, null, 4);
    return new Block(blockData).save( function( err, block, count ){
        if ( typeof err !== 'undefined' && err ) {
            if (err.code == 11000) {
                console.log('Skip: Duplicate key ' + 
                blockData.number.toString() + ': ' + 
                err);
            } else {
               console.log('Error: Aborted due to error on ' + 
                    'block number ' + blockData.number.toString() + ': ' + 
                    err);
               process.exit(9);
           }
        } else {
            if(!('quiet' in config && config.quiet === true)) {
                console.log('DB successfully written for block number ' +
                    blockData.number.toString() );
            }            
        }
      });
}

/**
  * Checks if the a record exists for the block number then ->
  *     if record exists: abort
  *     if record DNE: write a file for the block
  */
var checkBlockDBExistsThenWrite = function(config, blockData) {
    Block.find({number: blockData.number}, function (err, b) {
        if (!b.length)
            writeBlockToDB(config, blockData);
        else {
            console.log('Aborting because block number: ' + blockData.number.toString() + 
                ' already exists in DB.');
            process.exit(9);
        }

    })
}

/*
  Patch Missing Blocks
*/
var patchBlocks = function(config) {
    var web3 = new Web3(new Web3.providers.HttpProvider('http://localhost:' + 
        config.gethPort.toString()));

    // number of blocks should equal difference in block numbers
    var firstBlock = 0;
    var lastBlock = web3.eth.getBlock("latest").blockNumber;
    blockIter(web3, firstBlock, lastBlock, config);
}

var blockIter = function(web3, firstBlock, lastBlock, config) {
    // if consecutive, deal with it
    console.log(firstBlock)
    console.log(lastBlock)
    if (lastBlock < firstBlock)
        return;
    if (lastBlock - firstBlock === 1) {
        [lastBlock, firstBlock].forEach(function(blockNumber) {
            grabBlock(config, web3, blockNumber);
        });
    } else if (lastBlock === firstBlock) {
        Block.find({number: firstBlock}, function (err, b) {
            if (!b.length)
                grabBlock(config, web3, firstBlock);
        });
    } else {

        Block.count({number: {$gte: firstBlock, $lte: lastBlock}}, function(err, c) {
          var expectedBlocks = lastBlock - firstBlock + 1;
          if (expectedBlocks > c) {
            console.log("Missing: " + JSON.stringify(expectedBlocks - c));  
            var midBlock = firstBlock + parseInt((lastBlock - firstBlock)/2); 
            blockIter(web3, firstBlock, midBlock, config);
            blockIter(web3, midBlock + 1, lastBlock, config);
          } else 
            return;
        })
    }
}


/** On Startup **/
// geth --rpc --rpcaddr "localhost" --rpcport "8545"  --rpcapi "eth,net,web3"

var config = {};

try {
    var configContents = fs.readFileSync('config.json');
    config = JSON.parse(configContents);
}
catch (error) {
    if (error.code === 'ENOENT') {
        console.log('No config file found. Using default configuration (will ' + 
            'download all blocks starting from latest)');
    }
    else {
        throw error;
        process.exit(1);
    }
}

// set the default geth port if it's not provided
if (!('gethPort' in config) || (typeof config.gethPort) !== 'number') {
    config.gethPort = 8545; // default
}

// set the default output directory if it's not provided
if (!('output' in config) || (typeof config.output) !== 'string') {
    config.output = '.'; // default this directory
}

// set the default blocks if it's not provided
if (!('blocks' in config) || !(Array.isArray(config.blocks))) {
    config.blocks = [];
    config.blocks.push({'start': 0, 'end': 'latest'});
}

console.log('Using configuration:');
console.log(config);

// grabBlocks(config);
patchBlocks(config);
