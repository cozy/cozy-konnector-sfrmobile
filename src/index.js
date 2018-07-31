const moment = require('moment')
const bluebird = require('bluebird')
const cheerio = require('cheerio')

const {
  log,
  BaseKonnector,
  saveBills,
  request,
  retry
} = require('cozy-konnector-libs')

let rq = request({
  cheerio: true,
  json: false,
  jar: true,
  // debug: true,
  headers: {}
})

module.exports = new BaseKonnector(function fetch(fields) {
  return retry(getToken, {
    interval: 5000,
    throw_original: true
  })
    .then(token => logIn(token, fields))
    .then(() =>
      retry(fetchBillsAttempts, {
        interval: 5000,
        throw_original: true,
        // do not retry if we get the LOGIN_FAILED error code
        predicate: err => err.message !== 'LOGIN_FAILED'
      })
    )
    .then(entries =>
      saveBills(entries, fields.folderPath, {
        timeout: Date.now() + 60 * 1000,
        identifiers: 'SFR MOBILE'
      })
    )
    .catch(err => {
      // Connector is not in error if there is not entry in the end
      // It may be simply an empty account
      if (err.message === 'NO_ENTRY') return []
      throw err
    })
})

// Procedure to get the login token
function getToken() {
  log('info', 'Logging in on Sfr Website...')
  return rq(
    'https://www.sfr.fr/bounce?target=//www.sfr.fr/sfr-et-moi/bounce.html&casforcetheme=mire-sfr-et-moi&mire_layer'
  )
    .then($ => $('input[name=lt]').val())
    .then(token => {
      log('debug', token, 'TOKEN')
      if (!token) throw new Error('BAD_TOKEN')
      return token
    })
}

function logIn(token, fields) {
  return rq({
    method: 'POST',
    url:
      'https://www.sfr.fr/cas/login?domain=mire-sfr-et-moi&service=https://www.sfr.fr/accueil/j_spring_cas_security_check#sfrclicid=EC_mire_Me-Connecter',
    form: {
      lt: token,
      execution: 'e1s1',
      _eventId: 'submit',
      username: fields.login,
      password: fields.password,
      'remember-me': 'on',
      identifier: ''
    }
  })
    .then($ => {
      if ($('#loginForm').length) throw new Error('bad login')
    })
    .catch(err => {
      log('warn', err.message, 'Error while logging in')
      throw new Error('LOGIN_FAILED')
    })
}

function fetchBillsAttempts() {
  return fetchBillingInfo()
    .then(parsePage)
    .then(entries => {
      if (entries.length === 0) throw new Error('NO_ENTRY')
      return entries
    })
}

function fetchBillingInfo() {
  log('info', 'Fetching bill info')
  return rq({
    url: 'https://espace-client.sfr.fr/facture-mobile/consultation',
    resolveWithFullResponse: true,
    maxRedirects: 5 // avoids infinite redirection to facture-fixe if any
  }).then(response => {
    // check that the page was not redirected to another sfr service
    if (
      response.request.uri.path !== '/facture-mobile/consultation' ||
      response.request.uri.hostname !== 'espace-client.sfr.fr'
    ) {
      // this is the case where the user identified himself with other sfr login
      log('error', 'This is not SFR mobile identifier')
      throw new Error('LOGIN_FAILED')
    }

    return response.body
  })
}

function parsePage($) {
  const result = []
  moment.locale('fr')
  const baseURL = 'https://espace-client.sfr.fr'

  // handle the special case of the first bill
  const $firstBill = $('.sr-container-wrapper-m').eq(0)
  const firstBillUrl = $firstBill.find('#lien-telecharger-pdf').attr('href')

  if (firstBillUrl) {
    const fields = $firstBill
      .find('.sr-container-content')
      .eq(0)
      .find('span:not(.sr-text-grey-14)')
    const firstBillDate = moment(fields.eq(0).text(), 'DD MMMM YYYY')
    const price = fields
      .eq(1)
      .text()
      .replace('€', '')
      .replace(',', '.')

    const bill = {
      date: firstBillDate.toDate(),
      amount: parseFloat(price),
      fileurl: `${baseURL}${firstBillUrl}`,
      filename: getFileName(firstBillDate),
      vendor: 'SFR MOBILE'
    }

    result.push(bill)
  } else {
    log('info', 'wrong url for first PDF bill.')
  }

  let trs = Array.from($('table.sr-multi-payment tbody tr'))

  function getMoreBills() {
    // find some more rows if any
    return rq(`${baseURL}/facture-mobile/consultation/plusDeFactures`)
      .then($ => $('tr'))
      .then($trs => {
        if ($trs.length > trs.length) {
          trs = Array.from($trs)
          return getMoreBills()
        } else return Promise.resolve()
      })
  }

  return getMoreBills()
    .then(() => {
      return bluebird.mapSeries(trs, tr => {
        let link = $(tr)
          .find('td')
          .eq(1)
          .find('a')
        if (link.length === 1) {
          link = baseURL + link.attr('href')
          return rq(link).then($ =>
            $('.sr-container-wrapper-m')
              .eq(0)
              .html()
          )
        } else {
          return false
        }
      })
    })
    .then(list => list.filter(item => item))
    .then(list =>
      list.map(item => {
        const $ = cheerio.load(item)
        const fileurl = $('#lien-duplicata-pdf-').attr('href')
        const fields = $('.sr-container-content')
          .eq(0)
          .find('span:not(.sr-text-grey-14)')
        const date = moment(
          fields
            .eq(0)
            .text()
            .trim(),
          'DD MMMM YYYY'
        )
        const price = fields
          .eq(1)
          .text()
          .trim()
          .replace('€', '')
          .replace(',', '.')
        if (price) {
          const bill = {
            date: date.toDate(),
            amount: parseFloat(price),
            fileurl: `${baseURL}${fileurl}`,
            filename: getFileName(date),
            vendor: 'SFR MOBILE'
          }
          return bill
        } else return null
      })
    )
    .then(list => list.filter(item => item))
    .then(bills => {
      if (result.length) bills.unshift(result[0])
      return bills
    })
}

function getFileName(date) {
  return `${date.format('YYYYMM')}_sfr.pdf`
}
