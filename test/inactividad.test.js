// El timer de inactividad llama a handleInactiveUser a los 5 minutos.
// Si esa funcion no puede ver checkRoundCompletion, la excepcion no capturada
// dentro del setTimeout mata el proceso entero y desconecta a todos.
//
// Bug reproducido antes de arreglarlo:
//   ReferenceError: checkRoundCompletion is not defined
//       at handleInactiveUser (server.js:174:5)
const test = require('node:test');
const assert = require('node:assert');

const servidor = require('../server.js');

test.after(() => servidor.__test.cerrar());

test('handleInactiveUser no lanza con una ronda normal abierta', () => {
    servidor.__test.reset();
    servidor.__test.registrarUsuario('socket-1', 'claudio');
    servidor.__test.abrirVotacion('normal');

    assert.doesNotThrow(() => servidor.handleInactiveUser('socket-1'));
});

test('handleInactiveUser no lanza con una ronda de estrellas abierta', () => {
    servidor.__test.reset();
    servidor.__test.registrarUsuario('socket-2', 'bombo');
    servidor.__test.abrirVotacion('estrellas');

    assert.doesNotThrow(() => servidor.handleInactiveUser('socket-2'));
});

test('handleInactiveUser sale sin hacer nada si el socket no existe', () => {
    servidor.__test.reset();
    assert.doesNotThrow(() => servidor.handleInactiveUser('socket-inexistente'));
});
