const moment = require('moment')
const bluebird = require('bluebird')
const cheerio = require('cheerio')

const {
  log,
  CookieKonnector,
  retry,
  errors,
  solveCaptcha
} = require('cozy-konnector-libs')

class SfrConnector extends CookieKonnector {
  async fetch(fields) {
    if (!(await this.testSession())) {
      const { form, $ } = await retry(this.getForm, {
        interval: 5000,
        throw_original: true,
        context: this
      })

      await this.logIn(form, fields, $)
    }

    const entries = await retry(this.fetchBillsAttempts, {
      interval: 5000,
      throw_original: true,
      // do not retry if we get the LOGIN_FAILED error code
      predicate: err => err.message !== 'LOGIN_FAILED',
      context: this
    })

    await this.saveBills(entries, fields.folderPath, {
      identifiers: ['SFR MOBILE']
    })
  }
  async testSession() {
    const $ = await this.request(
      'https://espace-client.sfr.fr/facture-mobile/consultation'
    )
    return $('#loginForm').length === 0
  }

  async logIn(form, fields, $) {
    const submitForm = {
      ...form,
      username: fields.login,
      password: fields.password,
      'remember-me': 'on'
    }

    if ($('.g-recaptcha').length) {
      submitForm['g-recaptcha-response'] = await solveCaptcha({
        websiteKey: $('.g-recaptcha').data('sitekey'),
        websiteURL: 'https://www.sfr.fr/cas/login'
      })
    }

    const login$ = await this.request({
      method: 'POST',
      url:
        'https://www.sfr.fr/cas/login?domain=mire-sfr&service=https%3A%2F%2Fwww.sfr.fr%2Fj_spring_cas_security_check#sfrclicid=EC_mire_Me-Connecter',
      form: submitForm
    })

    if (login$('#loginForm').length) throw new Error(errors.LOGIN_FAILED)
  }

  fetchBillsAttempts() {
    return fetchBillingInfo
      .bind(this)()
      .then(parsePage.bind(this))
      .then(entries => {
        if (entries.length === 0) throw new Error('NO_ENTRY')
        return entries
      })
  }

  async getForm() {
    log('info', 'Logging in on Sfr Website...')
    const $ = await this.request('https://www.sfr.fr/cas/login')

    return { form: getFormData($('#loginForm')), $ }
  }
}

function getFormData($form) {
  return $form
    .serializeArray()
    .reduce((memo, input) => ({ ...memo, [input.name]: input.value }), {})
}

function fetchBillingInfo() {
  log('info', 'Fetching bill info')
  return this.request({
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
    return this.request(`${baseURL}/facture-mobile/consultation/plusDeFactures`)
      .then($ => $('tr'))
      .then($trs => {
        if ($trs.length > trs.length) {
          trs = Array.from($trs)
          return getMoreBills.bind(this)()
        } else return Promise.resolve()
      })
  }

  return getMoreBills
    .bind(this)()
    .then(() => {
      return bluebird.mapSeries(trs, tr => {
        let link = $(tr)
          .find('td')
          .eq(1)
          .find('a')
        if (link.length === 1) {
          link = baseURL + link.attr('href')
          return this.request(link).then($ =>
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

const connector = new SfrConnector({
  cheerio: true,
  json: false,
  // debug: true,
  headers: {}
})

connector.run()
